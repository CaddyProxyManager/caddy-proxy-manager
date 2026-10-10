/**
 * The Settings forms that stage: each save lands in the operator's change set rather than in
 * `settings`, a refused one stages nothing, and "Apply" commits the set, reloads Caddy
 * once and records a revision. Only `auth` is faked, so the real admin guard decides who may save.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  session: null as null | { user: import('../../helpers/settings-actions').SessionUser },
}));

ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  auth: vi.fn(async () => ctx.session),
}));

import messages from '../../../messages/en.json';
import * as actions from '@/src/app/(dashboard)/settings/actions';
import { setSetting } from '@/src/lib/settings';
import { domainErrorMessage } from '@/src/lib/errors/domain-error';
import { decryptSecret, isEncryptedSecret } from '@/src/lib/secrets';
import { invalidateSettingsCache } from '@/src/lib/settings/resolve';
import { settingsRevisions } from '@/src/lib/db/schema';
import { type FakeCaddy, installFakeCaddy } from '../../helpers/caddy-admin';
import {
  type SessionUser,
  form,
  seedUser,
  stagedKeys as stagedKeysIn,
  stagedSetting,
  storedSetting,
} from '../../helpers/settings-actions';

const results = messages.settings.results;
const STAGED = { success: true, staged: true, message: messages.settings.stagedSaved };

let admin: SessionUser;
let viewer: SessionUser;
let caddy: FakeCaddy;

type FormAction = (prev: null, form: FormData) => Promise<{ success: boolean; message?: string }>;

const staged = (key: string) => stagedSetting(ctx.db, admin.id, key);
const stored = (key: string) => storedSetting(ctx.db, key);
const stagedKeys = () => stagedKeysIn(ctx.db);

beforeEach(async () => {
  ctx.db = await createTestDb();
  invalidateSettingsCache();
  admin = await seedUser(ctx.db, 'admin@example.com', 'admin');
  viewer = await seedUser(ctx.db, 'viewer@example.com', 'user');
  ctx.session = { user: admin };
  caddy = installFakeCaddy();
});

/** One valid submission per staged block, and what lands in the change set for it. */
const VALID_SAVES: Array<{
  name: string;
  action: FormAction;
  fields: Record<string, string | string[]>;
  key: string;
  expected: Record<string, unknown>;
}> = [
  {
    name: 'general',
    action: actions.updateGeneralSettingsAction,
    fields: { defaultDomain: 'example.com', acmeEmail: 'ops@example.com' },
    key: 'general',
    expected: { defaultDomain: 'example.com', acmeEmail: 'ops@example.com' },
  },
  {
    name: 'ACME',
    action: actions.updateAcmeSettingsAction,
    fields: { caUrl: ' https://ca.example.com/directory ', caRootPem: '' },
    key: 'acme',
    expected: { caUrl: 'https://ca.example.com/directory' },
  },
  {
    name: 'Authentik',
    action: actions.updateAuthentikSettingsAction,
    fields: { outpostDomain: 'auth.example.com', outpostUpstream: 'http://authentik:9000' },
    key: 'authentik',
    expected: { outpostDomain: 'auth.example.com', outpostUpstream: 'http://authentik:9000' },
  },
  {
    name: 'forward auth, where anything but "custom" is Authelia',
    action: actions.updateForwardAuthSettingsAction,
    fields: { forwardAuthProvider: 'bogus', forwardAuthUpstream: 'authelia:9091' },
    key: 'forward_auth',
    expected: { provider: 'authelia', authUpstream: 'authelia:9091' },
  },
  {
    name: 'metrics, with an unreadable port falling back to 9090',
    action: actions.updateMetricsSettingsAction,
    fields: { enabled: 'on', port: 'abc' },
    key: 'metrics',
    expected: { enabled: true, port: 9090 },
  },
  {
    name: 'rate limiting, with the allowlist normalised',
    action: actions.updateRateLimitSettingsAction,
    fields: {
      rateLimitEnabled: 'on',
      rateLimitZonesJson: JSON.stringify([{ maxEvents: 60, window: '1m', key: 'ip' }]),
      rateLimitAllowlist: '10.0.0.1 192.168.0.0/16',
    },
    key: 'rate_limit',
    expected: {
      enabled: true,
      zones: [{ max_events: 60, window: '1m', key: 'ip' }],
      allowlist: ['10.0.0.1/32', '192.168.0.0/16'],
    },
  },
  {
    name: 'logging',
    action: actions.updateLoggingSettingsAction,
    fields: { enabled: 'on', format: 'console' },
    key: 'logging',
    expected: { enabled: true, format: 'console' },
  },
  {
    name: 'trusted proxies, split on commas and newlines',
    action: actions.updateTrustedProxiesSettingsAction,
    fields: { ranges: '10.0.0.0/8,\n192.168.0.0/16', clientIpHeaders: 'X-Real-IP', strict: 'on' },
    key: 'trusted_proxies',
    expected: {
      ranges: ['10.0.0.0/8', '192.168.0.0/16'],
      client_ip_headers: ['X-Real-IP'],
      strict: true,
    },
  },
  {
    name: 'HTTP protocols',
    action: actions.updateHttpProtocolsSettingsAction,
    fields: { http2: 'on' },
    key: 'http_protocols',
    expected: { http2: true, http3: false },
  },
  {
    name: 'compression',
    action: actions.updateCompressionSettingsAction,
    fields: { enabled: 'on' },
    key: 'compression',
    expected: { enabled: true },
  },
  {
    name: 'an empty global Caddyfile',
    action: actions.updateGlobalCaddyConfigAction,
    fields: { caddyfile: '' },
    key: 'global_caddy_config',
    expected: { caddyfile: '' },
  },
  {
    name: 'two-factor policy',
    action: actions.updateTwoFactorPolicySettingsAction,
    fields: { mode: 'admins', graceDays: '14' },
    key: 'two_factor_policy',
    expected: { mode: 'admins', graceDays: 14, requireForAdmins: true },
  },
  {
    name: 'DNS resolvers',
    action: actions.updateDnsSettingsAction,
    fields: { enabled: 'on', resolvers: '1.1.1.1, 8.8.8.8', fallbacks: '9.9.9.9', timeout: '5s' },
    key: 'dns',
    expected: {
      enabled: true,
      resolvers: ['1.1.1.1', '8.8.8.8'],
      fallbacks: ['9.9.9.9'],
      timeout: '5s',
    },
  },
  {
    name: 'upstream DNS resolution',
    action: actions.updateUpstreamDnsResolutionSettingsAction,
    fields: { enabled: 'on', family: 'ipv4' },
    key: 'upstream_dns_resolution',
    expected: { enabled: true, family: 'ipv4' },
  },
  {
    name: 'default response',
    action: actions.updateDefaultResponseSettingsAction,
    fields: { mode: 'respond', status: '418', body: 'teapot', headers: '' },
    key: 'default_response',
    expected: { mode: 'respond', status: 418, body: 'teapot' },
  },
  {
    name: 'default redirect',
    action: actions.updateDefaultResponseSettingsAction,
    fields: { mode: 'redirect', status: '301', redirectUrl: 'https://example.com/' },
    key: 'default_response',
    expected: { mode: 'redirect', status: 301, redirectUrl: 'https://example.com/' },
  },
  {
    name: 'a default response that drops the connection',
    action: actions.updateDefaultResponseSettingsAction,
    fields: { mode: 'abort', status: '500' },
    key: 'default_response',
    expected: { mode: 'abort' },
  },
  {
    name: 'the Gravatar fallback',
    action: actions.updateAvatarSettingsAction,
    fields: { gravatarEnabled: 'on' },
    key: 'avatars',
    expected: { gravatarEnabled: true },
  },
  {
    name: 'password policy',
    action: actions.updatePasswordPolicySettingsAction,
    fields: { requireChangeOnLegacyHash: 'on' },
    key: 'password_policy',
    expected: { requireChangeOnLegacyHash: true },
  },
  {
    name: 'error pages',
    action: actions.updateErrorPagesSettingsAction,
    fields: { errorPagesJson: '[]' },
    key: 'error_pages',
    expected: { rules: [] },
  },
];

// Joined at runtime: GitHub's secret scanning flags a literal shaped like a real key.
const FAKE_TAILSCALE_KEY = ['tskey', 'auth', 'kAbc-123'].join('-');
describe('a staged Settings form', () => {
  for (const save of VALID_SAVES) {
    it(`stages ${save.name} without touching settings or Caddy`, async () => {
      const result = await save.action(null, form(save.fields));

      expect(result).toEqual(STAGED);
      expect(await staged(save.key)).toMatchObject(save.expected);
      expect(await stored(save.key)).toBeUndefined();
      expect(caddy.loads).toHaveLength(0);
    });
  }

  it('unstages an edit put back to the stored value', async () => {
    await actions.updateCompressionSettingsAction(null, form({ enabled: 'on' }));
    await actions.applyStagedSettingsAction();

    // The same value again unstages rather than queueing a no-op.
    const result = await actions.updateCompressionSettingsAction(null, form({ enabled: 'on' }));

    expect(result).toEqual({ success: true, staged: true, message: messages.settings.stagedSaved });
    expect(await stagedKeys()).toEqual([]);
  });

  it('composes with an earlier staged edit of the same blob', async () => {
    await actions.updateGeoBlockSettingsAction(
      null,
      form({ geoblockEnabled: 'on', geoblockBlockCountries: 'RU, CN' }),
    );
    // A second read-modify-write sees the first one's staged value, not the stored one.
    await actions.updateWafSettingsAction(null, form({ wafEnabled: 'on', wafLoadOwaspCrs: 'on' }));
    await actions.updateWafSettingsAction(
      null,
      form({ wafEngineMode: 'DetectionOnly', wafLoadOwaspCrs: 'on', wafParanoiaLevel: '2' }),
    );

    expect(await staged('geoblock')).toMatchObject({ block_countries: ['RU', 'CN'] });
    expect(await staged('waf')).toMatchObject({
      enabled: true,
      mode: 'DetectionOnly',
      paranoia_level: 2,
    });
  });
});

describe('a refused staged save', () => {
  const REFUSALS: Array<{
    name: string;
    action: FormAction;
    fields: Record<string, string>;
    message: string;
  }> = [
    {
      name: 'a malformed ACME contact',
      action: actions.updateGeneralSettingsAction,
      fields: { defaultDomain: 'example.com', acmeEmail: 'not-an-address' },
      message: domainErrorMessage('emailInvalid'),
    },
    {
      name: 'an unreadable CA URL',
      action: actions.updateAcmeSettingsAction,
      fields: { caUrl: 'not a url' },
      message: results.acmeInvalidUrl,
    },
    {
      name: 'a plain-http CA',
      action: actions.updateAcmeSettingsAction,
      fields: { caUrl: 'http://ca.example.com/directory' },
      message: results.acmeHttpsRequired,
    },
    {
      name: 'Authentik without an upstream',
      action: actions.updateAuthentikSettingsAction,
      fields: { outpostDomain: 'auth.example.com' },
      message: results.authentikRequired,
    },
    {
      name: 'forward auth without an upstream',
      action: actions.updateForwardAuthSettingsAction,
      fields: { forwardAuthProvider: 'custom' },
      message: results.forwardAuthRequired,
    },
    {
      name: 'a never-limited entry that is no address',
      action: actions.updateRateLimitSettingsAction,
      fields: { rateLimitEnabled: 'on', rateLimitAllowlist: 'office' },
      message: domainErrorMessage('rateLimitAllowlistEntryInvalid', { value: 'office' }),
    },
    {
      name: 'an unknown log format',
      action: actions.updateLoggingSettingsAction,
      fields: { enabled: 'on', format: 'xml' },
      message: results.loggingInvalidFormat,
    },
    {
      name: 'custom DNS on with no resolver',
      action: actions.updateDnsSettingsAction,
      fields: { enabled: 'on', resolvers: ' , ' },
      message: results.dnsResolverRequired,
    },
    {
      name: 'an unknown address family',
      action: actions.updateUpstreamDnsResolutionSettingsAction,
      fields: { enabled: 'on', family: 'ipv5' },
      message: results.upstreamDnsInvalidFamily,
    },
    {
      name: 'unreadable error page JSON',
      action: actions.updateErrorPagesSettingsAction,
      fields: { errorPagesJson: '{nope' },
      message: results.errorPagesInvalid,
    },
    {
      name: 'an unknown default response mode',
      action: actions.updateDefaultResponseSettingsAction,
      fields: { mode: 'teapot' },
      message: results.defaultResponseInvalidMode,
    },
    {
      name: 'a control character in the global Caddyfile',
      action: actions.updateGlobalCaddyConfigAction,
      fields: { caddyfile: '{\n\u0001\n}' },
      message: domainErrorMessage('globalCaddyfileControlCharacter'),
    },
    {
      name: 'a WAF in-memory body limit above the body limit',
      action: actions.updateWafSettingsAction,
      fields: { wafEnabled: 'on', wafRequestBodyLimitMb: '1', wafRequestBodyInMemoryLimitMb: '2' },
      message: results.wafBodyLimitExceeded,
    },
    {
      name: 'a WAF preset that does not exist',
      action: actions.updateWafSettingsAction,
      fields: { wafEnabled: 'on', wafPresetIds: '[4242]' },
      message: domainErrorMessage('wafPresetUnknownIds', { ids: ['4242'] }),
    },
    {
      name: 'a Tailscale key checked with no API token',
      action: actions.updateTailscaleSettingsAction,
      fields: { tailscaleAuthKey: FAKE_TAILSCALE_KEY, tailscaleValidateAuthKey: 'on' },
      message: results.tailscaleKeyRejected.replace(
        '{reason}',
        'Checking auth keys needs a Tailscale API access token (tskey-api-…). Add one, or turn the check off.',
      ),
    },
  ];

  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.name} and stages nothing`, async () => {
      const result = await refusal.action(null, form(refusal.fields));

      expect(result).toEqual({ success: false, message: refusal.message });
      expect(await stagedKeys()).toEqual([]);
    });
  }
});

describe('the staged blocks that keep a secret', () => {
  it('encrypts a Cloudflare token and keeps it when the field comes back blank', async () => {
    await actions.updateCloudflareSettingsAction(
      null,
      form({ apiToken: ' cf-token ', zoneId: 'z1' }),
    );
    const first = await staged('cloudflare');
    expect(isEncryptedSecret(first.apiToken)).toBe(true);
    expect(decryptSecret(first.apiToken)).toBe('cf-token');

    await actions.updateCloudflareSettingsAction(null, form({ accountId: 'acct' }));
    const second = await staged('cloudflare');
    expect(decryptSecret(second.apiToken)).toBe('cf-token');
    expect(second).toMatchObject({ accountId: 'acct' });
    expect(second.zoneId).toBeUndefined();

    await actions.updateCloudflareSettingsAction(null, form({ clearToken: 'on' }));
    expect(decryptSecret((await staged('cloudflare')).apiToken)).toBe('');
  });

  it('saves a Tailscale key the check cannot read, such as a Caddy placeholder', async () => {
    const result = await actions.updateTailscaleSettingsAction(
      null,
      form({
        tailscaleAuthKey: '{env.TS_AUTHKEY}',
        tailscaleApiAccessToken: 'tskey-api-x',
        tailscaleValidateAuthKey: 'on',
      }),
    );

    expect(result).toEqual(STAGED);
    expect(decryptSecret((await staged('tailscale')).authKey)).toBe('{env.TS_AUTHKEY}');
  });

  it('keeps the Tailscale auth key across an edit that leaves it blank', async () => {
    const first = await actions.updateTailscaleSettingsAction(
      null,
      form({
        tailscaleEnabled: 'on',
        tailscaleAuthKey: 'tskey-auth-kAbc-123',
        tailscaleTags: 'tag:a, tag:b',
      }),
    );
    expect(first).toEqual(STAGED);
    const saved = await staged('tailscale');
    expect(saved).toMatchObject({ enabled: true, tags: ['tag:a', 'tag:b'], apiTailnet: '-' });
    expect(decryptSecret(saved.authKey)).toBe('tskey-auth-kAbc-123');

    await actions.updateTailscaleSettingsAction(
      null,
      form({ tailscaleEnabled: 'on', tailscaleEphemeral: 'on' }),
    );
    const again = await staged('tailscale');
    expect(again.ephemeral).toBe(true);
    expect(decryptSecret(again.authKey)).toBe('tskey-auth-kAbc-123');
  });

  it('stages an external CrowdSec with its bouncer key encrypted', async () => {
    const result = await actions.updateCrowdSecSettingsAction(
      null,
      form({
        crowdsecEnabled: 'on',
        crowdsecMode: 'external',
        crowdsecApiUrl: 'http://crowdsec:8080',
        crowdsecApiKey: 'bouncer-key',
      }),
    );

    expect(result).toEqual(STAGED);
    const saved = await staged('crowdsec');
    expect(saved).toMatchObject({
      enabled: true,
      mode: 'external',
      apiUrl: 'http://crowdsec:8080',
    });
    expect(decryptSecret(saved.apiKey)).toBe('bouncer-key');
  });

  it('refuses an external CrowdSec with no bouncer key', async () => {
    const result = await actions.updateCrowdSecSettingsAction(
      null,
      form({
        crowdsecEnabled: 'on',
        crowdsecMode: 'external',
        crowdsecApiUrl: 'http://crowdsec:8080',
      }),
    );

    expect(result.success).toBe(false);
    expect(await stagedKeys()).toEqual([]);
  });

  it('stages the HTTP cache with its Redis password encrypted', async () => {
    const result = await actions.updateHttpCacheSettingsAction(
      null,
      form({
        storage: 'redis',
        redisAddresses: 'redis:6379',
        redisPassword: 's3cret',
        redisDb: '0',
      }),
    );

    expect(result).toEqual(STAGED);
    const saved = await staged('http_cache');
    expect(saved.storage).toBe('redis');
    expect(isEncryptedSecret(saved.redis.password)).toBe(true);
  });
});

describe('geoblocking', () => {
  it('parses the lists, keeps only well-formed headers and falls back on a bad status', async () => {
    const result = await actions.updateGeoBlockSettingsAction(
      null,
      form({
        geoblockEnabled: 'on',
        geoblockBlockCountries: 'RU, CN,',
        geoblockBlockAsns: '13335, nope, 15169',
        geoblockAllowIps: '203.0.113.7',
        geoblockResponseStatus: '999',
        geoblockResponseBody: '   ',
        geoblockRedirectUrl: 'javascript:alert(1)',
        'geoblockResponseHeadersKeys[]': ['X-Blocked', 'bad header', ''],
        'geoblockResponseHeadersValues[]': [' yes ', 'dropped', 'dropped'],
      }),
    );

    expect(result).toEqual(STAGED);
    expect(await staged('geoblock')).toEqual({
      enabled: true,
      block_countries: ['RU', 'CN'],
      block_continents: [],
      block_asns: [13335, 15169],
      block_cidrs: [],
      block_ips: [],
      allow_countries: [],
      allow_continents: [],
      allow_asns: [],
      allow_cidrs: [],
      allow_ips: ['203.0.113.7'],
      trusted_proxies: [],
      fail_closed: false,
      response_status: 403,
      response_body: 'Forbidden',
      response_headers: { 'X-Blocked': 'yes' },
      redirect_url: '',
    });
  });

  it('keeps a valid status, body and http(s) redirect', async () => {
    await actions.updateGeoBlockSettingsAction(
      null,
      form({
        geoblockResponseStatus: '451',
        geoblockResponseBody: 'Unavailable here',
        geoblockRedirectUrl: 'https://example.com/blocked',
      }),
    );

    expect(await staged('geoblock')).toMatchObject({
      enabled: false,
      response_status: 451,
      response_body: 'Unavailable here',
      redirect_url: 'https://example.com/blocked',
    });
  });
});

describe('WAF settings', () => {
  it('stages the rule exclusions, body limits and action it was given', async () => {
    const result = await actions.updateWafSettingsAction(
      null,
      form({
        wafEnabled: 'on',
        wafLoadOwaspCrs: 'on',
        wafCustomDirectives: '   ',
        wafExcludedRuleIds: '[942100, -1, "x", 920350]',
        wafRequestBodyLimitMb: '10',
        wafRequestBodyInMemoryLimitMb: '1',
        wafRequestBodyLimitAction: 'ProcessPartial',
      }),
    );

    expect(result).toEqual(STAGED);
    const waf = await staged('waf');
    expect(waf).toMatchObject({
      enabled: true,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: '',
      excluded_rule_ids: [942100, 920350],
      request_body_limit_action: 'ProcessPartial',
    });
    expect(waf.request_body_limit).toBeGreaterThan(waf.request_body_in_memory_limit);
  });

  it('refuses a directive that would switch the engine off, and stages nothing', async () => {
    // Only the strict setting refuses it; otherwise it is sent with a warning.
    const result = await actions.updateWafSettingsAction(
      null,
      form({
        wafEnabled: 'on',
        wafStrictDirectives: 'on',
        wafCustomDirectives: 'SecRuleEngine Off',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('"SecRuleEngine Off"');
    expect(await stagedKeys()).toEqual([]);
  });

  it('keeps stored legacy exclusions when the form does not post them', async () => {
    await setSetting('waf', {
      enabled: false,
      mode: 'Off',
      load_owasp_crs: true,
      custom_directives: '',
      excluded_rule_ids: [941100],
    });
    await actions.updateWafSettingsAction(null, form({ wafEnabled: 'on' }));

    expect(await staged('waf')).toMatchObject({ mode: 'On', excluded_rule_ids: [941100] });
  });

  it('stages the tuning, leaving defaults out', async () => {
    await actions.updateWafSettingsAction(
      null,
      form({
        wafEngineMode: 'On',
        wafParanoiaLevel: '1',
        wafLogNextParanoiaLevel: 'on',
        wafInboundThreshold: '10',
        wafOutboundThreshold: '4',
      }),
    );

    const waf = await staged('waf');
    expect(waf).toMatchObject({ log_next_paranoia_level: true, inbound_anomaly_threshold: 10 });
    expect(waf).not.toHaveProperty('paranoia_level');
    expect(waf).not.toHaveProperty('outbound_anomaly_threshold');
  });

  it('refuses a paranoia level out of range, and stages nothing', async () => {
    const result = await actions.updateWafSettingsAction(
      null,
      form({ wafEngineMode: 'On', wafParanoiaLevel: '5' }),
    );

    expect(result.success).toBe(false);
    expect(await stagedKeys()).toEqual([]);
  });
});

describe('dashboard host', () => {
  it('checks no DNS before a domain is saved', async () => {
    expect(await actions.checkDashboardDnsAction()).toEqual({
      ok: true,
      data: { ok: false, resolved: [], reason: 'noDomain' },
    });
  });

  it('stages the dashboard route', async () => {
    const result = await actions.updateDashboardSettingsAction(
      null,
      form({ enabled: 'on', domain: ' proxy.example.com ', tls: 'on' }),
    );

    expect(result).toEqual(STAGED);
    expect(await staged('dashboard')).toMatchObject({
      enabled: true,
      domain: 'proxy.example.com',
      tls: true,
    });
  });

  it('refuses a dashboard route with no domain', async () => {
    const result = await actions.updateDashboardSettingsAction(null, form({ enabled: 'on' }));

    expect(result).toEqual({
      success: false,
      message: 'dashboard.domain must contain between 1 and 253 characters',
    });
    expect(await stagedKeys()).toEqual([]);
  });
});

// Registry writes bypass staging: nothing here reaches a Caddy config.
describe('update checks', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('saves the check off at once, without calling out or wiping the repository', async () => {
    const calls = vi.fn();
    globalThis.fetch = calls as unknown as typeof fetch;

    const result = await actions.updateUpdateSettingsAction(null, form({}));

    expect(result).toEqual({ success: true, message: results.updatesDisabled });
    expect(await stored('config:update_check_enabled')).toBe(false);
    expect(await stored('config:update_image_repository')).toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
    expect(await stagedKeys()).toEqual([]);
  });

  it('checks inline once switched on, and keeps the result out of the change set', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      asked.push(String(url));
      return Response.json({ tags: ['0.0.1', 'latest'] });
    }) as unknown as typeof fetch;

    const result = await actions.updateUpdateSettingsAction(
      null,
      form({ updateCheckEnabled: 'on', updateImageRepository: 'ghcr.io/example/fork' }),
    );

    expect(result).toEqual({
      success: true,
      message: results.updatesSavedLatest.replace('{latest}', '0.0.1'),
    });
    expect(asked[0]).toStartWith('https://ghcr.io/v2/example/fork/');
    expect(await stored('config:update_image_repository')).toBe('ghcr.io/example/fork');
    expect(await stored('update_check')).toMatchObject({ latest: '0.0.1', error: null });
    expect(await stagedKeys()).toEqual([]);
  });

  it('saves, but says the check failed, when the registry refuses', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;

    const result = await actions.updateUpdateSettingsAction(
      null,
      form({ updateCheckEnabled: 'on' }),
    );

    expect(result).toEqual({
      success: false,
      message: results.updatesSavedCheckFailed.replace(
        '{error}',
        domainErrorMessage('registryRepositoryNotFound'),
      ),
    });
    expect(await stored('config:update_check_enabled')).toBe(true);
  });
});

describe('the favicon', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const upload = (file: File) => {
    const data = new FormData();
    data.set('favicon', file);
    return data;
  };

  it('stages an image by its sniffed type, then a removal, and applies each', async () => {
    const svgNamed = new File([PNG], 'icon.svg', { type: 'image/svg+xml' });
    expect(await actions.updateFaviconAction(null, upload(svgNamed))).toEqual(STAGED);
    expect((await staged('branding')).favicon).toMatchObject({ type: 'image/png' });
    expect(await stored('branding')).toBeUndefined();

    await actions.applyStagedSettingsAction();
    expect((await stored('branding')).favicon).toMatchObject({ type: 'image/png' });

    expect(await actions.updateFaviconAction(null, form({ intent: 'remove' }))).toEqual(STAGED);
    // A staged clear is the JSON null, which reads as no favicon.
    expect(await staged('branding')).toBeNull();
    expect((await stored('branding')).favicon).toBeDefined();

    await actions.applyStagedSettingsAction();
    expect(await stored('branding')).toBeNull();
  });

  it('stages no removal of a favicon that was never stored', async () => {
    await actions.updateFaviconAction(null, form({ intent: 'remove' }));
    expect(await stagedKeys()).toEqual([]);
  });

  it('asks for a file, and refuses one that is not an image', async () => {
    expect(await actions.updateFaviconAction(null, form())).toEqual({
      success: false,
      message: results.faviconChooseFile,
    });

    const html = new File(['<html></html>'], 'icon.png', { type: 'image/png' });
    expect(await actions.updateFaviconAction(null, upload(html))).toEqual({
      success: false,
      message: domainErrorMessage('faviconNotImage'),
    });
    expect(await stagedKeys()).toEqual([]);
  });

  it('refuses a non-administrator', async () => {
    ctx.session = { user: viewer };
    expect(await actions.updateFaviconAction(null, form({ intent: 'remove' }))).toEqual({
      success: false,
      message: domainErrorMessage('accessDenied'),
    });
  });
});

describe('who may stage', () => {
  it('refuses a non-administrator before anything is read or staged', async () => {
    ctx.session = { user: viewer };

    for (const save of VALID_SAVES) {
      expect(await save.action(null, form(save.fields))).toEqual({
        success: false,
        message: domainErrorMessage('accessDenied'),
      });
    }
    expect(await stagedKeys()).toEqual([]);
  });
});

describe('applying the change set', () => {
  it('commits every staged key, reloads Caddy once and records the revision', async () => {
    await actions.updateCompressionSettingsAction(null, form({ enabled: 'on' }));
    await actions.updateHttpProtocolsSettingsAction(null, form({ http2: 'on', http3: 'on' }));

    const result = await actions.applyStagedSettingsAction();

    const [revision] = await ctx.db.select().from(settingsRevisions);
    expect(result).toEqual({
      success: true,
      message: results.stagedApplied.replace('{revision}', String(revision.id)),
    });
    expect(await stored('compression')).toEqual({ enabled: true });
    expect(await stored('http_protocols')).toEqual({ http2: true, http3: true });
    expect(await stagedKeys()).toEqual([]);
    expect(caddy.loads).toHaveLength(1);
    expect(revision).toMatchObject({
      appliedBy: Number(admin.id),
      appliedByName: 'admin',
      outcome: 'applied',
    });
    expect(JSON.parse(revision.keys).sort()).toEqual(['compression', 'http_protocols']);
  });

  it('keeps the values but says so when Caddy does not reload', async () => {
    await actions.updateCompressionSettingsAction(null, form({ enabled: 'on' }));
    caddy.failWith(500, 'boom');

    const result = await actions.applyStagedSettingsAction();

    expect(result.success).toBe(true);
    expect(result.message).toStartWith('Changes applied, but Caddy did not reload:');
    expect(await stored('compression')).toEqual({ enabled: true });
    const [revision] = await ctx.db.select().from(settingsRevisions);
    expect(revision.outcome).toBe('failed');
  });

  it('refuses an empty change set', async () => {
    const result = await actions.applyStagedSettingsAction();

    expect(result).toEqual({ success: false, message: domainErrorMessage('nothingStagedToApply') });
    expect(await ctx.db.select().from(settingsRevisions)).toEqual([]);
  });

  it('discards one key, or the whole set', async () => {
    await actions.updateCompressionSettingsAction(null, form({ enabled: 'on' }));
    await actions.updateTwoFactorPolicySettingsAction(null, form({ mode: 'admins' }));

    expect(await actions.discardStagedSettingsAction('compression')).toEqual({ success: true });
    expect(await stagedKeys()).toEqual(['two_factor_policy']);

    expect(await actions.discardStagedSettingsAction()).toEqual({ success: true });
    expect(await stagedKeys()).toEqual([]);
  });

  it('stages the values an earlier revision had', async () => {
    await actions.updateCompressionSettingsAction(null, form({ enabled: 'on' }));
    await actions.applyStagedSettingsAction();
    await actions.updateCompressionSettingsAction(null, form({}));
    await actions.applyStagedSettingsAction();
    const [second] = await ctx.db
      .select({ id: settingsRevisions.id })
      .from(settingsRevisions)
      .orderBy(settingsRevisions.id);

    const result = await actions.restoreRevisionAction(second.id);

    expect(result).toMatchObject({ success: true, staged: true });
    expect(await staged('compression')).toEqual({ enabled: true });
  });

  it('refuses to restore a revision that does not exist', async () => {
    const result = await actions.restoreRevisionAction(99);

    expect(result).toEqual({
      success: false,
      message: domainErrorMessage('revisionNotFound', { revision: 99 }),
    });
  });

  it('turns a non-administrator away from apply, discard and restore', async () => {
    await actions.updateCompressionSettingsAction(null, form({ enabled: 'on' }));
    ctx.session = { user: viewer };
    const refused = { success: false, message: domainErrorMessage('accessDenied') };

    expect(await actions.applyStagedSettingsAction()).toEqual(refused);
    expect(await actions.discardStagedSettingsAction()).toEqual(refused);
    expect(await actions.restoreRevisionAction(1)).toEqual(refused);
    expect(await stagedKeys()).toEqual(['compression']);
    expect(await stored('compression')).toBeUndefined();
  });
});
