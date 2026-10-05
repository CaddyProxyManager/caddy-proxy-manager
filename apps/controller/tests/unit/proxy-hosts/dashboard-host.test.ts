import { describe, expect, it } from 'bun:test';
import {
  DASHBOARD_HOST_ID,
  buildDashboardHostRow,
  checkDashboardDns,
  isHostname,
} from '@/src/lib/dashboard-host';
import { pairingHostFor } from '@/src/lib/dashboard-host/address';
import { createProbeNonce, probeSignatureMatches, signProbe } from '@/src/lib/reachability/probe';
import { validateSettingsGroup } from '@/src/lib/settings/validation';

const on = { enabled: true, domain: 'cpm.example.com', tls: false };

describe('the managed dashboard host', () => {
  it('is absent unless there is something to serve', () => {
    expect(buildDashboardHostRow(null, 'web:3000')).toBeNull();
    expect(buildDashboardHostRow({ ...on, enabled: false }, 'web:3000')).toBeNull();
    expect(buildDashboardHostRow({ ...on, domain: '   ' }, 'web:3000')).toBeNull();
    // An unknown dial address would produce a host that claims the domain and then answers with a
    // proxy error. Not claiming it at all leaves the operator a working port instead.
    expect(buildDashboardHostRow(on, null)).toBeNull();
  });

  it('points the domain at the controller', () => {
    const row = buildDashboardHostRow(on, 'web:3000');

    expect(row?.id).toBe(DASHBOARD_HOST_ID);
    expect(JSON.parse(row?.domains ?? '[]')).toEqual(['cpm.example.com']);
    expect(JSON.parse(row?.upstreams ?? '[]')).toEqual(['http://web:3000']);
    expect(row?.enabled).toBe(1);
    // The dashboard streams events and builds absolute URLs from the request host.
    expect(row?.allowWebsocket).toBe(1);
    expect(row?.preserveHostHeader).toBe(1);
  });

  it('never carries an id a stored host could also have', () => {
    // Serials start at 1, so a negative id cannot collide - and anything looking this host up by
    // id finds nothing rather than somebody else's access list or certificate.
    expect(DASHBOARD_HOST_ID).toBeLessThan(0);
  });

  it('normalises the domain it was given', () => {
    const row = buildDashboardHostRow({ ...on, domain: '  CPM.Example.COM ' }, 'web:3000');
    expect(JSON.parse(row?.domains ?? '[]')).toEqual(['cpm.example.com']);
  });

  it('ties HSTS to TLS', () => {
    // HSTS over a host that is not on HTTPS pins the browser to a scheme this host does not serve,
    // and nothing in this UI can clear that for the visitor.
    expect(buildDashboardHostRow({ ...on, tls: false }, 'web:3000')?.hstsEnabled).toBe(0);
    expect(buildDashboardHostRow({ ...on, tls: false }, 'web:3000')?.sslForced).toBe(0);

    const secure = buildDashboardHostRow({ ...on, tls: true }, 'web:3000');
    expect(secure?.hstsEnabled).toBe(1);
    expect(secure?.sslForced).toBe(1);
  });

  it('carries its proxy options into the row', () => {
    const meta = JSON.stringify({ redirects: [{ from: '/old', to: '/new', status: 301 }] });
    const row = buildDashboardHostRow(
      {
        ...on,
        tls: true,
        options: {
          certificateId: 7,
          accessListId: 3,
          hstsSubdomains: true,
          skipHttpsHostnameValidation: true,
          agentIds: [2],
          meta,
        },
      },
      'web:3000',
    );

    expect(row?.certificateId).toBe(7);
    expect(row?.accessListId).toBe(3);
    expect(row?.hstsSubdomains).toBe(1);
    expect(row?.skipHttpsHostnameValidation).toBe(1);
    expect(row?.meta).toBe(meta);
    // Never from the options: the dashboard needs both to work at all.
    expect(row?.allowWebsocket).toBe(1);
    expect(row?.preserveHostHeader).toBe(1);
    expect(JSON.parse(row?.upstreams ?? '[]')).toEqual(['http://web:3000']);
  });

  it('keeps HSTS subdomains off while TLS is', () => {
    const row = buildDashboardHostRow(
      {
        ...on,
        tls: false,
        options: {
          certificateId: null,
          accessListId: null,
          hstsSubdomains: true,
          skipHttpsHostnameValidation: false,
          agentIds: [],
          meta: null,
        },
      },
      'web:3000',
    );

    expect(row?.hstsSubdomains).toBe(0);
  });

  it('reads settings saved before it had options as a host with none', () => {
    const row = buildDashboardHostRow(on, 'web:3000');

    expect(row?.certificateId).toBeNull();
    expect(row?.accessListId).toBeNull();
    expect(row?.meta).toBeNull();
  });
});

describe('the dashboard reachability check', () => {
  const deps = (resolved: string[], reached: boolean) => ({
    resolveAddresses: async () => resolved,
    probe: async () => reached,
  });

  it('confirms a domain that arrives here', async () => {
    const result = await checkDashboardDns('cpm.example.com', deps(['203.0.113.10'], true));

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('reached');
  });

  it('trusts the probe over the record', async () => {
    // The record is only a diagnostic. A name that resolves to nothing this resolver can see but
    // still reaches us - split DNS, a hosts entry, a search domain - has answered the question.
    const result = await checkDashboardDns('cpm.example.com', deps([], true));

    expect(result.ok).toBe(true);
  });

  it('refuses a domain that resolves but does not reach here', async () => {
    const result = await checkDashboardDns('cpm.example.com', deps(['198.51.100.7'], false));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('otherServer');
    // Reported so the operator can see where it currently points.
    expect(result.resolved).toEqual(['198.51.100.7']);
  });

  it('separates a name that resolves nowhere from one pointed elsewhere', async () => {
    expect((await checkDashboardDns('cpm.example.com', deps([], false))).reason).toBe('unresolved');
    expect((await checkDashboardDns('  ', deps(['203.0.113.10'], true))).reason).toBe('noDomain');
  });

  it('answers rather than throwing when the lookup fails', async () => {
    // Rendering a warning is not a place to handle an exception, and a broken resolver must not
    // become an error the operator has to deal with.
    const result = await checkDashboardDns('cpm.example.com', {
      resolveAddresses: async () => {
        throw new Error('SERVFAIL');
      },
      probe: async () => false,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unresolved');
  });
});

describe('the probe signature', () => {
  it('accepts only what this instance signed', () => {
    const nonce = createProbeNonce();

    expect(probeSignatureMatches(nonce, signProbe(nonce))).toBe(true);
    // A server that merely echoes the nonce, or answers with anything else, is not this instance.
    expect(probeSignatureMatches(nonce, nonce)).toBe(false);
    expect(probeSignatureMatches(nonce, '')).toBe(false);
    expect(probeSignatureMatches(nonce, signProbe(`${nonce}x`))).toBe(false);
  });

  it('gives every check a different nonce', () => {
    // A fixed nonce would let a server that once saw a valid answer replay it later.
    expect(createProbeNonce()).not.toBe(createProbeNonce());
  });
});

describe('the hostname gate', () => {
  it('accepts names and bare addresses', () => {
    for (const value of [
      'cpm.example.com',
      'example.com',
      'localhost',
      'a-b.c-d.example',
      '10.0.0.5',
    ]) {
      expect(isHostname(value), value).toBe(true);
    }
  });

  it('refuses anything that could carry more than a host', () => {
    // The reachability check interpolates this into a URL. Each of these would make that request
    // go somewhere other than the host it appears to name, which is what CodeQL objected to.
    for (const value of [
      'example.com/path',
      'example.com:8080',
      'user@example.com',
      'example.com?x=1',
      'example.com#f',
      'http://example.com',
      '//evil.example.com',
      '[::1]',
      'exam ple.com',
      'example.com\nHost: evil',
      '',
      '   ',
      `${'a'.repeat(254)}`,
    ]) {
      expect(isHostname(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('is what the probe checks before requesting anything', async () => {
    // deps.probe is not supplied, so a domain that got past the gate would reach the real fetch.
    // A refused one must answer without making a request at all.
    const result = await checkDashboardDns('evil.example.com/redirect', {
      resolveAddresses: async () => [],
    });

    expect(result.ok).toBe(false);
  });
});

describe('dashboard settings validation', () => {
  it('accepts a complete group', () => {
    expect(
      validateSettingsGroup('dashboard', { enabled: true, domain: 'cpm.example.com', tls: false }),
    ).toEqual({ enabled: true, domain: 'cpm.example.com', tls: false });
  });

  it('requires the domain even when the host is off', () => {
    // It is what the route is rebuilt from the moment this is switched back on, so a blank one
    // would store a setting that silently produces nothing.
    expect(() =>
      validateSettingsGroup('dashboard', { enabled: false, domain: '', tls: false }),
    ).toThrow();
  });

  it('refuses a domain that is not a hostname', () => {
    // Closed at the source too: nothing that fails the gate can be stored, so the Caddy host
    // matcher this feeds cannot receive it either.
    expect(() =>
      validateSettingsGroup('dashboard', {
        enabled: true,
        domain: 'example.com/path',
        tls: false,
      }),
    ).toThrow();
  });

  it('refuses unknown keys and wrong types', () => {
    expect(() =>
      validateSettingsGroup('dashboard', { enabled: true, domain: 'a.example.com', tls: 'yes' }),
    ).toThrow();
    expect(() =>
      validateSettingsGroup('dashboard', {
        enabled: true,
        domain: 'a.example.com',
        tls: false,
        upstream: 'web:3000',
      }),
    ).toThrow();
  });

  const options = {
    certificateId: null,
    accessListId: 4,
    hstsSubdomains: false,
    skipHttpsHostnameValidation: false,
    agentIds: [1, 2],
    meta: '{"redirects":[{"from":"/a","to":"/b","status":301}]}',
  };
  const withOptions = (overrides: Record<string, unknown>) => ({
    enabled: true,
    domain: 'cpm.example.com',
    tls: false,
    options: { ...options, ...overrides },
  });

  it('accepts proxy options', () => {
    const input = withOptions({});
    expect(validateSettingsGroup('dashboard', input)).toEqual(input);
    expect(() => validateSettingsGroup('dashboard', withOptions({ meta: null }))).not.toThrow();
  });

  it('refuses malformed proxy options', () => {
    expect(() => validateSettingsGroup('dashboard', withOptions({ meta: 'not json' }))).toThrow(
      /JSON object/,
    );
    expect(() => validateSettingsGroup('dashboard', withOptions({ meta: '[1]' }))).toThrow();
    expect(() => validateSettingsGroup('dashboard', withOptions({ agentIds: [0] }))).toThrow();
    expect(() => validateSettingsGroup('dashboard', withOptions({ certificateId: '1' }))).toThrow();
    expect(() => validateSettingsGroup('dashboard', withOptions({ upstreams: [] }))).toThrow(
      /unknown field/,
    );
    const { hstsSubdomains: _, ...missing } = options;
    expect(() =>
      validateSettingsGroup('dashboard', {
        enabled: true,
        domain: 'cpm.example.com',
        tls: false,
        options: missing,
      }),
    ).toThrow(/required/);
  });
});

describe('the pairing command address', () => {
  it('is the bare domain once the host is on HTTPS', () => {
    // A bare public name is https on 443 to the agent, which is where Caddy serves it.
    expect(pairingHostFor({ ...on, domain: ' CPM.Example.com ', tls: true })).toEqual({
      host: 'cpm.example.com',
      insecure: false,
    });
  });

  it('spells out http and port 80 while the host is on plain HTTP', () => {
    // `http://` alone would send the agent to the controller's own port 3000.
    expect(pairingHostFor({ ...on, tls: false })).toEqual({
      host: 'http://cpm.example.com:80',
      insecure: true,
    });
  });

  it('is absent when the host is off or has no domain', () => {
    expect(pairingHostFor(null)).toBeNull();
    expect(pairingHostFor({ ...on, enabled: false })).toBeNull();
    expect(pairingHostFor({ ...on, domain: '  ' })).toBeNull();
  });
});
