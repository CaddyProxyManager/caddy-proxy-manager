/**
 * The Tailscale JSON shapes and the settings normalizer. Caddy rejects a posted config as a whole,
 * so a listener address or a module name that is wrong here takes every host offline - these are
 * the pieces that decide those strings, checked without a database.
 */
import { describe, it, expect } from 'bun:test';

import {
  buildTailscaleApp,
  buildTailscaleAuthHandler,
  buildTailscaleAuthSubroute,
  buildTailscaleAutomationPolicy,
  buildTailscaleTransport,
  buildTailscaleIdentityHeadersHandler,
  buildTailscaleIdentityStripHandler,
  DEFAULT_TAILSCALE_SETTINGS,
  isTailscaleDomain,
  normalizeNodeName,
  normalizeTailscaleSettings,
  redactTailscaleSettingsForApi,
  TAILSCALE_IDENTITY_HEADERS,
  tailscaleListenAddresses,
  validateNodeName,
  type TailscaleSettings,
} from '@/src/lib/caddy-tailscale';

const settings = (overrides: Partial<TailscaleSettings> = {}): TailscaleSettings => ({
  ...DEFAULT_TAILSCALE_SETTINGS,
  tags: [],
  ...overrides,
});

describe('node names', () => {
  it('lowercases, so one machine is not registered twice', () => {
    expect(normalizeNodeName('  Caddy  ')).toBe('caddy');
  });

  it('accepts a DNS label and rejects anything a tailnet would not', () => {
    expect(validateNodeName('caddy')).toBeNull();
    expect(validateNodeName('edge-01')).toBeNull();
    expect(validateNodeName('')).toMatch(/required/);
    expect(validateNodeName('-caddy')).toMatch(/not a valid/);
    expect(validateNodeName('caddy-')).toMatch(/not a valid/);
    expect(validateNodeName('caddy.example')).toMatch(/not a valid/);
  });

  it('rejects a name that would break out of the listener address', () => {
    // The name lands in `tailscale/<node>:443`. A slash or a colon would silently retarget the
    // listener rather than fail, so it has to be refused at the input.
    expect(validateNodeName('caddy/../evil')).toMatch(/not a valid/);
    expect(validateNodeName('caddy:2019')).toMatch(/not a valid/);
  });
});

describe('normalizeTailscaleSettings', () => {
  it('fills in the defaults for an empty blob', () => {
    const result = normalizeTailscaleSettings({});
    expect(result.enabled).toBe(false);
    expect(result.defaultNode).toBe('caddy');
    expect(result.tags).toEqual([]);
    // Off by default: it is the only thing here that reaches Tailscale on its own.
    expect(result.validateAuthKey).toBe(false);
    expect(result.apiTailnet).toBe('-');
    // Off by default: an h3 listener wedges Caddy's config load while the control server is down.
    expect(result.http3).toBe(false);
  });

  it('keeps an opted-in HTTP/3 flag', () => {
    expect(normalizeTailscaleSettings({ http3: true }).http3).toBe(true);
  });

  it('defaults the tailnet to the token own', () => {
    expect(normalizeTailscaleSettings({ apiTailnet: '  ' }).apiTailnet).toBe('-');
  });

  it('rejects a tailnet that would corrupt the request path', () => {
    expect(() => normalizeTailscaleSettings({ apiTailnet: 'a/../b' })).toThrow(/not valid/);
  });

  it('deduplicates and lowercases tags', () => {
    expect(normalizeTailscaleSettings({ tags: ['tag:Caddy', 'tag:caddy'] }).tags).toEqual([
      'tag:caddy',
    ]);
  });

  it('rejects a tag that is not in tag:name form', () => {
    expect(() => normalizeTailscaleSettings({ tags: ['caddy'] })).toThrow(/not valid/);
  });

  it('rejects a control server that is not an http URL', () => {
    expect(() => normalizeTailscaleSettings({ controlUrl: 'ftp://x' })).toThrow(/http/);
    expect(() => normalizeTailscaleSettings({ controlUrl: 'not a url' })).toThrow(/valid URL/);
  });

  it('rejects a relative or traversing state directory', () => {
    expect(() => normalizeTailscaleSettings({ stateDir: 'tailscale' })).toThrow(/absolute/);
    expect(() => normalizeTailscaleSettings({ stateDir: '/data/../etc' })).toThrow(/absolute/);
  });

  it('rejects an auth key with whitespace in it', () => {
    // A key reaches Caddy as one JSON string; whitespace means a paste went wrong, not a key.
    expect(() => normalizeTailscaleSettings({ authKey: 'tskey-auth abc' })).toThrow(/whitespace/);
  });

  it('keeps a Caddy placeholder as the auth key', () => {
    expect(normalizeTailscaleSettings({ authKey: '{env.TS_AUTHKEY}' }).authKey).toBe(
      '{env.TS_AUTHKEY}',
    );
  });

  it('survives a round trip through its own output', () => {
    // The stored blob is re-normalized on every read, so anything it emits has to be accepted.
    const once = normalizeTailscaleSettings({
      enabled: true,
      authKey: 'tskey-auth-abc',
      controlUrl: 'https://headscale.example.com',
      ephemeral: true,
      stateDir: '/data/tailscale',
      tags: ['tag:caddy'],
      defaultNode: 'edge',
    });
    expect(normalizeTailscaleSettings(once)).toEqual(once);
  });
});

describe('redactTailscaleSettingsForApi', () => {
  it('replaces the key with whether one exists', () => {
    const view = redactTailscaleSettingsForApi(settings({ authKey: 'tskey-auth-abc' }));
    expect(view.hasAuthKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('tskey');
  });

  it('reports no key for an empty one', () => {
    expect(redactTailscaleSettingsForApi(settings({ authKey: '' })).hasAuthKey).toBe(false);
  });

  it('withholds the API access token too', () => {
    const view = redactTailscaleSettingsForApi(settings({ apiAccessToken: 'tskey-api-abc' }));
    expect(view.hasApiAccessToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain('tskey-api-abc');
  });
});

describe('buildTailscaleApp', () => {
  it('emits only what is set', () => {
    expect(buildTailscaleApp(settings(), '')).toEqual({ state_dir: '/data/tailscale' });
  });

  it('carries the decrypted key, control URL, tags and ephemeral flag', () => {
    expect(
      buildTailscaleApp(
        settings({
          controlUrl: 'https://headscale.example.com',
          ephemeral: true,
          tags: ['tag:caddy'],
        }),
        'tskey-auth-abc',
      ),
    ).toEqual({
      auth_key: 'tskey-auth-abc',
      control_url: 'https://headscale.example.com',
      ephemeral: true,
      state_dir: '/data/tailscale',
      tags: ['tag:caddy'],
    });
  });

  it('never emits a nodes map', () => {
    // The node's hostname is derived from the name in its listener address. A `nodes` entry would
    // be a second place for the same string to live, and the two would drift.
    expect(buildTailscaleApp(settings({ defaultNode: 'edge' }), '')).not.toHaveProperty('nodes');
  });
});

describe('listener addresses', () => {
  it('binds both ports on the node', () => {
    expect(tailscaleListenAddresses('caddy')).toEqual([
      'tailscale/caddy:80',
      'tailscale/caddy:443',
    ]);
  });
});

describe('identity handlers', () => {
  it('names the plugin provider, not a handler of its own', () => {
    // `tailscale_auth` adapts to Caddy's own authentication handler with the plugin as a provider.
    expect(buildTailscaleAuthHandler()).toEqual({
      handler: 'authentication',
      providers: { tailscale: {} },
    });
  });

  it('strips exactly the headers it sets', () => {
    const strip = buildTailscaleIdentityStripHandler() as {
      request: { delete: string[] };
    };
    const set = buildTailscaleIdentityHeadersHandler() as {
      request: { set: Record<string, string[]> };
    };
    expect(strip.request.delete.sort()).toEqual(Object.keys(set.request.set).sort());
  });

  it('reads each value from the placeholder Caddy sets for that metadata key', () => {
    expect(TAILSCALE_IDENTITY_HEADERS['X-Tailscale-Login']).toBe(
      '{http.auth.user.tailscale_login}',
    );
    for (const placeholder of Object.values(TAILSCALE_IDENTITY_HEADERS)) {
      expect(placeholder).toStartWith('{http.auth.user.tailscale_');
    }
  });

  it('sets the headers inside the auth subroute, so an unauthenticated route never does', () => {
    const withIdentity = buildTailscaleAuthSubroute(true) as {
      routes: { handle: { handler: string }[] }[];
    };
    expect(withIdentity.routes[0].handle.map((h) => h.handler)).toEqual([
      'authentication',
      'headers',
    ]);

    const without = buildTailscaleAuthSubroute(false) as {
      routes: { handle: { handler: string }[] }[];
    };
    expect(without.routes[0].handle.map((h) => h.handler)).toEqual(['authentication']);
  });
});

describe('buildTailscaleTransport', () => {
  it('names the node and carries the TLS config through unchanged', () => {
    expect(buildTailscaleTransport('edge', { insecure_skip_verify: true })).toEqual({
      protocol: 'tailscale',
      name: 'edge',
      tls: { insecure_skip_verify: true },
    });
  });

  it('omits tls entirely for a plain http upstream', () => {
    // Any non-nil TLS config makes the plugin speak https, so an empty object is not the same as
    // absent - it would turn an http upstream into an https one.
    expect(buildTailscaleTransport('edge', null)).toEqual({ protocol: 'tailscale', name: 'edge' });
  });
});

describe('certificates', () => {
  it('recognizes a MagicDNS name', () => {
    expect(isTailscaleDomain('app.tail1234.ts.net')).toBe(true);
    expect(isTailscaleDomain('APP.TAIL1234.TS.NET')).toBe(true);
    expect(isTailscaleDomain('app.example.com')).toBe(false);
    // Not a suffix match on the label alone.
    expect(isTailscaleDomain('ts.net.example.com')).toBe(false);
  });

  it('builds a manager-only policy, with no issuer to fall back to ACME', () => {
    // Caddy skips issuer provisioning for a policy whose subjects are all .ts.net and whose
    // managers include this one. An `issuers` key would put it back on ACME, which cannot
    // validate a name that resolves only inside a tailnet.
    const policy = buildTailscaleAutomationPolicy(['app.tail1234.ts.net']);
    expect(policy).toEqual({
      subjects: ['app.tail1234.ts.net'],
      get_certificate: [{ via: 'tailscale' }],
    });
    expect(policy).not.toHaveProperty('issuers');
  });
});
