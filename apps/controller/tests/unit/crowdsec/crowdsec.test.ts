/**
 * CrowdSec's settings shape, the key kept only for the addresses it was saved for, the Caddy JSON,
 * and the controller-side LAPI probe.
 */
import { describe, expect, it } from 'bun:test';
import {
  assertCrowdSecComplete,
  buildCrowdSecApp,
  crowdSecConnection,
  crowdSecL4DenySets,
  type CrowdSecSettings,
  DEFAULT_CROWDSEC_SETTINGS,
  goDurationMs,
  hostCrowdSecEnabled,
  generateManagedBouncerKey,
  keepStoredCrowdSecKey,
  MANAGED_CROWDSEC_API_URL,
  MANAGED_CROWDSEC_APPSEC_URL,
  normalizeCrowdSecSettings,
  probeCrowdSecLapi,
  redactCrowdSecSettings,
  sanitizeHostCrowdSec,
  storedHostCrowdSec,
  wantsManagedCrowdSec,
  withManagedCrowdSecKey,
} from '@/src/lib/caddy/crowdsec';
import { DomainError } from '@/src/lib/errors/domain-error';
import { validateSettingsGroup } from '@/src/lib/settings/validation';

const CONFIGURED: CrowdSecSettings = {
  enabled: true,
  mode: 'external',
  onlineApi: false,
  managedAppsec: false,
  managedApiKey: '',
  apiUrl: 'http://crowdsec:8080',
  apiKey: 'bouncer-key',
  appsecUrl: '',
  appsecFailOpen: false,
  tickerInterval: '60s',
};

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).code;
  }
  return undefined;
}

describe('normalizeCrowdSecSettings', () => {
  it('fills the defaults and trims the trailing slash', () => {
    expect(normalizeCrowdSecSettings({})).toEqual(DEFAULT_CROWDSEC_SETTINGS);
    expect(normalizeCrowdSecSettings({ apiUrl: ' http://crowdsec:8080/ ' }).apiUrl).toBe(
      'http://crowdsec:8080',
    );
  });

  it('allows plain http only to a private address, since the key travels with it', () => {
    expect(normalizeCrowdSecSettings({ apiUrl: 'http://10.0.0.4:8080' }).apiUrl).toBe(
      'http://10.0.0.4:8080',
    );
    expect(normalizeCrowdSecSettings({ apiUrl: 'https://lapi.example.com' }).apiUrl).toBe(
      'https://lapi.example.com',
    );
    expect(codeOf(() => normalizeCrowdSecSettings({ apiUrl: 'http://lapi.example.com' }))).toBe(
      'crowdsecApiUrlHttps',
    );
    expect(
      codeOf(() => normalizeCrowdSecSettings({ appsecUrl: 'http://appsec.example.com' })),
    ).toBe('crowdsecAppsecUrlHttps');
  });

  it('refuses a URL with credentials, a query or another scheme', () => {
    for (const apiUrl of [
      'ftp://crowdsec',
      'http://u:p@crowdsec:8080',
      'http://crowdsec/?a=1',
      'x',
    ]) {
      expect(codeOf(() => normalizeCrowdSecSettings({ apiUrl }))).toBe('crowdsecApiUrlInvalid');
    }
  });

  it('refuses a key with whitespace or control characters', () => {
    expect(codeOf(() => normalizeCrowdSecSettings({ apiKey: 'a b' }))).toBe(
      'crowdsecApiKeyInvalid',
    );
    expect(codeOf(() => normalizeCrowdSecSettings({ apiKey: 'a\nb' }))).toBe(
      'crowdsecApiKeyInvalid',
    );
    expect(normalizeCrowdSecSettings({ apiKey: '{env.CROWDSEC_KEY}' }).apiKey).toBe(
      '{env.CROWDSEC_KEY}',
    );
  });

  it('takes a Go duration between 1s and 24h for the ticker', () => {
    expect(normalizeCrowdSecSettings({ tickerInterval: '1m30s' }).tickerInterval).toBe('1m30s');
    for (const tickerInterval of ['500ms', '25h', '1d', '10', 'soon']) {
      expect(codeOf(() => normalizeCrowdSecSettings({ tickerInterval }))).toBe(
        'crowdsecTickerInvalid',
      );
    }
  });
});

describe('goDurationMs', () => {
  it('reads what time.ParseDuration reads, and nothing else', () => {
    expect(goDurationMs('60s')).toBe(60_000);
    expect(goDurationMs('1h2m')).toBe(3_720_000);
    expect(goDurationMs('1.5s')).toBe(1500);
    expect(goDurationMs('1d')).toBeNull();
    expect(goDurationMs('1s ')).toBeNull();
    expect(goDurationMs('')).toBeNull();
  });
});

describe('the stored bouncer key', () => {
  const stored = { ...CONFIGURED, apiKey: 'enc:v1:stored' };

  it('is kept for a blank key while both addresses are unchanged', () => {
    expect(keepStoredCrowdSecKey({ ...CONFIGURED, apiKey: '' }, stored).apiKey).toBe(
      'enc:v1:stored',
    );
  });

  it('is dropped when either address changes, so it cannot be pointed elsewhere', () => {
    const moved = keepStoredCrowdSecKey(
      { ...CONFIGURED, apiKey: '', apiUrl: 'https://evil.example.com' },
      stored,
    );
    expect(moved.apiKey).toBe('');
    expect(codeOf(() => assertCrowdSecComplete(moved, stored))).toBe('crowdsecApiKeyReenter');
    const appsec = keepStoredCrowdSecKey(
      { ...CONFIGURED, apiKey: '', appsecUrl: 'https://evil.example.com' },
      stored,
    );
    expect(appsec.apiKey).toBe('');
  });

  it('gives way to a new key', () => {
    expect(keepStoredCrowdSecKey({ ...CONFIGURED, apiKey: 'new' }, stored).apiKey).toBe('new');
  });

  it('is required to switch CrowdSec on, and the address with it', () => {
    expect(codeOf(() => assertCrowdSecComplete({ ...CONFIGURED, apiKey: '' }, null))).toBe(
      'crowdsecApiKeyRequired',
    );
    expect(codeOf(() => assertCrowdSecComplete({ ...CONFIGURED, apiUrl: '' }, null))).toBe(
      'crowdsecApiUrlRequired',
    );
    expect(() =>
      assertCrowdSecComplete({ ...CONFIGURED, enabled: false, apiKey: '', apiUrl: '' }, null),
    ).not.toThrow();
  });

  it('is never in the redacted view', () => {
    const view = redactCrowdSecSettings(CONFIGURED);
    expect(view).toEqual({
      ...CONFIGURED,
      apiKey: undefined,
      managedApiKey: undefined,
      hasApiKey: true,
    } as never);
    expect(JSON.stringify(view)).not.toContain('bouncer-key');
  });
});

describe('managed mode', () => {
  const MANAGED: CrowdSecSettings = {
    ...CONFIGURED,
    mode: 'managed',
    apiUrl: '',
    apiKey: '',
    managedApiKey: 'enc:v1:managed',
  };

  it('reads an unknown mode as an error and a missing one as external', () => {
    expect(normalizeCrowdSecSettings({}).mode).toBe('external');
    expect(normalizeCrowdSecSettings({ mode: 'managed' }).mode).toBe('managed');
    expect(codeOf(() => normalizeCrowdSecSettings({ mode: 'cloud' }))).toBe('crowdsecModeInvalid');
  });

  it('mints a key on the first switch to managed and keeps it after', () => {
    const minted = withManagedCrowdSecKey({ ...MANAGED, managedApiKey: '' }, null, () => 'fresh');
    expect(minted.managedApiKey).toBe('fresh');
    const kept = withManagedCrowdSecKey({ ...MANAGED, managedApiKey: '' }, MANAGED, () => 'fresh');
    expect(kept.managedApiKey).toBe('enc:v1:managed');
  });

  it('never takes the key from what was submitted', () => {
    const submitted = { ...MANAGED, managedApiKey: 'attacker-chosen' };
    expect(withManagedCrowdSecKey(submitted, null, () => 'fresh').managedApiKey).toBe('fresh');
    expect(withManagedCrowdSecKey(submitted, MANAGED).managedApiKey).toBe('enc:v1:managed');
    const external = { ...CONFIGURED, managedApiKey: 'attacker-chosen' };
    expect(withManagedCrowdSecKey(external, null).managedApiKey).toBe('');
  });

  it('keeps the managed key through a spell in external mode', () => {
    expect(withManagedCrowdSecKey(CONFIGURED, MANAGED).managedApiKey).toBe('enc:v1:managed');
  });

  it('generates 64 hex characters, which Compose takes unquoted', () => {
    const key = generateManagedBouncerKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(generateManagedBouncerKey()).not.toBe(key);
  });

  it('needs no address or key typed in to switch on', () => {
    expect(() => assertCrowdSecComplete({ ...MANAGED, managedApiKey: '' }, null)).not.toThrow();
  });

  it('points Caddy at the container, with the managed key', () => {
    const connection = crowdSecConnection(MANAGED);
    expect(connection).toMatchObject({
      apiUrl: MANAGED_CROWDSEC_API_URL,
      apiKey: 'enc:v1:managed',
      appsecUrl: '',
      managed: true,
    });
    expect(crowdSecConnection({ ...MANAGED, managedAppsec: true })?.appsecUrl).toBe(
      MANAGED_CROWDSEC_APPSEC_URL,
    );
  });

  it('ignores the external address and key while managed', () => {
    const connection = crowdSecConnection({
      ...MANAGED,
      apiUrl: 'https://lapi.example.com',
      apiKey: 'external-key',
      appsecUrl: 'https://appsec.example.com',
    });
    expect(connection?.apiUrl).toBe(MANAGED_CROWDSEC_API_URL);
    expect(connection?.apiKey).toBe('enc:v1:managed');
    expect(connection?.appsecUrl).toBe('');
  });

  it('gives an agent that does not run the container no connection', () => {
    expect(crowdSecConnection(MANAGED, false)).toBeNull();
    // External mode is every agent's.
    expect(crowdSecConnection(CONFIGURED, false)?.managed).toBe(false);
  });

  it('wants the container only while switched on in managed mode', () => {
    expect(wantsManagedCrowdSec(MANAGED)).toBe(true);
    expect(wantsManagedCrowdSec({ ...MANAGED, enabled: false })).toBe(false);
    expect(wantsManagedCrowdSec(CONFIGURED)).toBe(false);
    expect(wantsManagedCrowdSec(null)).toBe(false);
  });

  it('never shows the managed key, and REST cannot set it', () => {
    expect(redactCrowdSecSettings(MANAGED)).not.toHaveProperty('managedApiKey');
    expect(JSON.stringify(redactCrowdSecSettings(MANAGED))).not.toContain('enc:v1:managed');
    expect(() =>
      validateSettingsGroup('crowdsec', { enabled: true, mode: 'managed', managedApiKey: 'k' }),
    ).toThrow();
    expect(() =>
      validateSettingsGroup('crowdsec', {
        enabled: true,
        mode: 'managed',
        onlineApi: true,
        managedAppsec: true,
      }),
    ).not.toThrow();
    expect(() => validateSettingsGroup('crowdsec', { enabled: true, mode: 'cloud' })).toThrow();
    expect(() => validateSettingsGroup('crowdsec', { enabled: true, onlineApi: 'yes' })).toThrow();
  });
});

describe('Caddy JSON', () => {
  it('streams decisions and never fails hard', () => {
    const connection = crowdSecConnection(CONFIGURED);
    expect(connection).not.toBeNull();
    expect(buildCrowdSecApp(connection!, 'plain-key')).toEqual({
      api_url: 'http://crowdsec:8080',
      api_key: 'plain-key',
      ticker_interval: '60s',
      enable_streaming: true,
      enable_hard_fails: false,
    });
  });

  it('adds AppSec with its fail-open choice spelled out', () => {
    const connection = crowdSecConnection({
      ...CONFIGURED,
      appsecUrl: 'http://crowdsec:7422',
      appsecFailOpen: false,
    });
    expect(buildCrowdSecApp(connection!, 'k')).toMatchObject({
      appsec_url: 'http://crowdsec:7422',
      appsec_fail_open: false,
    });
  });

  it('has no connection until enabled with an address and a key', () => {
    expect(crowdSecConnection(null)).toBeNull();
    expect(crowdSecConnection({ ...CONFIGURED, enabled: false })).toBeNull();
    expect(crowdSecConnection({ ...CONFIGURED, apiKey: '' })).toBeNull();
  });

  it('denies at L4 by negating the matcher, which matches an allowed address', () => {
    expect(crowdSecL4DenySets()).toEqual([{ not: [{ crowdsec: {} }] }]);
  });
});

describe('per-host opt-out', () => {
  it('stores only an opt-out, and reads anything else as on', () => {
    expect(storedHostCrowdSec(true)).toBeUndefined();
    expect(storedHostCrowdSec(false)).toEqual({ enabled: false });
    expect(sanitizeHostCrowdSec({ enabled: true })).toBeUndefined();
    expect(sanitizeHostCrowdSec('off')).toBeUndefined();
    expect(hostCrowdSecEnabled(undefined)).toBe(true);
    expect(hostCrowdSecEnabled({ enabled: false })).toBe(false);
  });
});

describe('probeCrowdSecLapi', () => {
  function fakeFetch(answer: () => Response | Promise<Response>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return answer();
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('asks for one address with the key in X-Api-Key, following no redirect', async () => {
    const { impl, calls } = fakeFetch(() => Response.json(null));
    expect(await probeCrowdSecLapi('http://crowdsec:8080', 'k3y', impl)).toEqual({ status: 'ok' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://crowdsec:8080/v1/decisions?ip=127.0.0.1');
    expect((calls[0].init?.headers as Record<string, string> | undefined)?.['X-Api-Key']).toBe(
      'k3y',
    );
    expect(calls[0].init?.redirect).toBe('manual');
  });

  it('tells a refused key from an unexpected answer and an unreachable server', async () => {
    const forbidden = fakeFetch(
      () => new Response('{"message":"access forbidden"}', { status: 403 }),
    );
    expect(await probeCrowdSecLapi('http://crowdsec:8080', 'k', forbidden.impl)).toEqual({
      status: 'rejected',
    });
    const moved = fakeFetch(() => new Response(null, { status: 302 }));
    expect(await probeCrowdSecLapi('http://crowdsec:8080', 'k', moved.impl)).toEqual({
      status: 'unexpected',
      httpStatus: 302,
    });
    const down = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await probeCrowdSecLapi('http://crowdsec:8080', 'k', down.impl)).toEqual({
      status: 'unreachable',
    });
  });

  it('sends nothing for a placeholder key or a public http address', async () => {
    const { impl, calls } = fakeFetch(() => Response.json(null));
    expect(await probeCrowdSecLapi('http://crowdsec:8080', '{env.KEY}', impl)).toEqual({
      status: 'placeholder',
    });
    expect(await probeCrowdSecLapi('http://lapi.example.com', 'k', impl)).toEqual({
      status: 'unreachable',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('REST validation', () => {
  it('accepts a write without the key and refuses unknown fields', () => {
    expect(() =>
      validateSettingsGroup('crowdsec', { enabled: true, apiUrl: 'http://crowdsec:8080' }),
    ).not.toThrow();
    expect(() => validateSettingsGroup('crowdsec', { enabled: true, hasApiKey: true })).toThrow();
    expect(() => validateSettingsGroup('crowdsec', { enabled: 'yes' })).toThrow();
    expect(() =>
      validateSettingsGroup('crowdsec', { enabled: true, apiUrl: 'http://lapi.example.com' }),
    ).toThrow();
  });
});
