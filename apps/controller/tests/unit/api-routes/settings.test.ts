import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';

// updateGeneralSettingsAction reads its messages from the catalog; there is no request scope here.
vi.mock('next-intl/server', () => nextIntlServerMock());

vi.mock('@/src/lib/settings', () => ({
  getGeneralSettings: vi.fn(),
  saveGeneralSettings: vi.fn(),
  getAcmeSettings: vi.fn(),
  saveAcmeSettings: vi.fn(),
  getCloudflareSettings: vi.fn(),
  saveCloudflareSettings: vi.fn(),
  getAuthentikSettings: vi.fn(),
  saveAuthentikSettings: vi.fn(),
  getForwardAuthSettings: vi.fn(),
  saveForwardAuthSettings: vi.fn(),
  getMetricsSettings: vi.fn(),
  saveMetricsSettings: vi.fn(),
  getLoggingSettings: vi.fn(),
  saveLoggingSettings: vi.fn(),
  getDnsSettings: vi.fn(),
  saveDnsSettings: vi.fn(),
  getDnsProviderSettings: vi.fn(),
  saveDnsProviderSettings: vi.fn(),
  getUpstreamDnsResolutionSettings: vi.fn(),
  saveUpstreamDnsResolutionSettings: vi.fn(),
  getGeoBlockSettings: vi.fn(),
  saveGeoBlockSettings: vi.fn(),
  getWafSettings: vi.fn(),
  saveWafSettings: vi.fn(),
  getErrorPagesSettings: vi.fn(),
  saveErrorPagesSettings: vi.fn(),
  getTrustedProxiesSettings: vi.fn(),
  saveTrustedProxiesSettings: vi.fn(),
  getDefaultResponseSettings: vi.fn(),
  saveDefaultResponseSettings: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  clearSetting: vi.fn(),
}));

vi.mock('@/src/lib/auth', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: '1' } }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/models/proxy-hosts', () => ({
  listProxyHosts: vi.fn(),
  updateProxyHost: vi.fn(),
  sanitizeErrorPageRules: vi.fn((rules: unknown) => rules),
}));
vi.mock('@/src/lib/models/waf-events', () => ({ getWafRuleMessages: vi.fn() }));

vi.mock('@/src/lib/caddy', () => ({
  applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/src/lib/api-auth', () => {
  const ApiAuthError = class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
      this.name = 'ApiAuthError';
    }
  };
  return {
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    requireApiUser: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    apiErrorResponse: vi.fn((error: unknown) => {
      const { NextResponse: NR } = require('next/server');
      if (error instanceof ApiAuthError) {
        return NR.json({ error: error.message }, { status: error.status });
      }
      return NR.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 },
      );
    }),
    logUnexpectedApiError: vi.fn(() => 'test-error-id'),
    ApiAuthError,
  };
});

const { GET, PUT } = await import('@/src/app/api/v1/settings/[group]/route');
import {
  getGeneralSettings,
  saveGeneralSettings,
  getAcmeSettings,
  saveAcmeSettings,
  getCloudflareSettings,
  saveCloudflareSettings,
  getAuthentikSettings,
  saveAuthentikSettings,
  getForwardAuthSettings,
  saveForwardAuthSettings,
  getMetricsSettings,
  saveMetricsSettings,
  getLoggingSettings,
  saveLoggingSettings,
  getDnsSettings,
  saveDnsSettings,
  getUpstreamDnsResolutionSettings,
  saveUpstreamDnsResolutionSettings,
  getGeoBlockSettings,
  saveGeoBlockSettings,
  getWafSettings,
  saveWafSettings,
  getTrustedProxiesSettings,
  saveTrustedProxiesSettings,
  getDefaultResponseSettings,
  saveDefaultResponseSettings,
  getDnsProviderSettings,
  getSetting,
  setSetting,
  clearSetting,
} from '@/src/lib/settings';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { requireApiAdmin } from '@/src/lib/api-auth';
import { DefaultResponseValidationError } from '@/src/lib/caddy-default-response';
import { updateGeneralSettingsAction } from '@/src/app/(dashboard)/settings/actions';

const mockGetGeneral = vi.mocked(getGeneralSettings);
const mockSaveGeneral = vi.mocked(saveGeneralSettings);
const mockGetAcme = vi.mocked(getAcmeSettings);
const mockSaveAcme = vi.mocked(saveAcmeSettings);
const mockGetCloudflare = vi.mocked(getCloudflareSettings);
const mockSaveCloudflare = vi.mocked(saveCloudflareSettings);
const mockGetAuthentik = vi.mocked(getAuthentikSettings);
const mockSaveAuthentik = vi.mocked(saveAuthentikSettings);
const mockGetForwardAuth = vi.mocked(getForwardAuthSettings);
const mockSaveForwardAuth = vi.mocked(saveForwardAuthSettings);
const mockGetMetrics = vi.mocked(getMetricsSettings);
const mockSaveMetrics = vi.mocked(saveMetricsSettings);
const mockGetLogging = vi.mocked(getLoggingSettings);
const mockSaveLogging = vi.mocked(saveLoggingSettings);
const mockGetDns = vi.mocked(getDnsSettings);
const mockSaveDns = vi.mocked(saveDnsSettings);
const mockGetUpstreamDns = vi.mocked(getUpstreamDnsResolutionSettings);
const mockSaveUpstreamDns = vi.mocked(saveUpstreamDnsResolutionSettings);
const mockGetGeoBlock = vi.mocked(getGeoBlockSettings);
const mockSaveGeoBlock = vi.mocked(saveGeoBlockSettings);
const mockGetWaf = vi.mocked(getWafSettings);
const mockSaveWaf = vi.mocked(saveWafSettings);
const mockGetTrustedProxies = vi.mocked(getTrustedProxiesSettings);
const mockSaveTrustedProxies = vi.mocked(saveTrustedProxiesSettings);
const mockGetDefaultResponse = vi.mocked(getDefaultResponseSettings);
const mockSaveDefaultResponse = vi.mocked(saveDefaultResponseSettings);
const mockGetDnsProvider = vi.mocked(getDnsProviderSettings);
const mockGetSetting = vi.mocked(getSetting);
const mockSetSetting = vi.mocked(setSetting);
const mockClearSetting = vi.mocked(clearSetting);
const mockApplyCaddyConfig = vi.mocked(applyCaddyConfig);
const mockRequireApiAdmin = vi.mocked(requireApiAdmin);

function createMockRequest(options: { method?: string; body?: unknown } = {}): any {
  return {
    headers: { get: () => null },
    method: options.method ?? 'GET',
    nextUrl: { pathname: '/api/v1/settings/general', searchParams: new URLSearchParams() },
    json: async () => options.body ?? {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireApiAdmin.mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' });
  mockGetSetting.mockResolvedValue(null);
  mockApplyCaddyConfig.mockResolvedValue({ ok: true } as any);
  // clearAllMocks keeps implementations, so an unconsumed `...Once` would leak into the next test.
  mockSaveDefaultResponse.mockReset();
  mockSaveDefaultResponse.mockResolvedValue(undefined);
});

describe('GET /api/v1/settings/[group]', () => {
  it('returns general settings', async () => {
    const settings = { site_name: 'My Proxy', admin_email: 'admin@example.com' };
    mockGetGeneral.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'general' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
  });

  it('returns empty object when settings are null', async () => {
    mockGetGeneral.mockResolvedValue(null as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'general' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({});
  });

  it('returns default response settings', async () => {
    const settings = { mode: 'respond', status: 404, body: 'Not Found' } as const;
    mockGetDefaultResponse.mockResolvedValue(settings);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'default-response' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(settings);
    expect(mockGetDefaultResponse).toHaveBeenCalled();
  });

  it('returns explicit Caddy mode when default response settings are unset', async () => {
    mockGetDefaultResponse.mockResolvedValue(null);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'default-response' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'caddy' });
  });

  it('returns only DNS-provider configuration metadata and never credential values', async () => {
    const plaintextSecret = 'dns-plaintext-secret-sentinel';
    const encryptedSecret = 'enc:v1:dns-ciphertext-sentinel';
    mockGetDnsProvider.mockResolvedValue({
      providers: {
        cloudflare: { api_token: plaintextSecret },
        route53: {
          access_key_id: 'access-key-sentinel',
          secret_access_key: encryptedSecret,
          region: 'eu-test-1',
          unused: '',
        },
      },
      default: 'cloudflare',
    });

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'dns-provider' }),
    });
    const bodyText = await response.text();
    const data = JSON.parse(bodyText);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(data).toEqual({
      providers: {
        cloudflare: { configuredFields: ['api_token'] },
        route53: {
          configuredFields: ['access_key_id', 'region', 'secret_access_key'],
        },
      },
      default: 'cloudflare',
    });
    expect(bodyText).not.toContain(plaintextSecret);
    expect(bodyText).not.toContain(encryptedSecret);
    expect(bodyText).not.toContain('access-key-sentinel');
    expect(bodyText).not.toContain('eu-test-1');
  });

  it('does not return the legacy Cloudflare API token', async () => {
    mockGetCloudflare.mockResolvedValue({
      apiToken: 'legacy-cloudflare-token-sentinel',
      zoneId: 'zone-id',
      accountId: 'account-id',
    });

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'cloudflare' }),
    });
    const bodyText = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(bodyText)).toEqual({
      hasApiToken: true,
      zoneId: 'zone-id',
      accountId: 'account-id',
    });
    expect(bodyText).not.toContain('legacy-cloudflare-token-sentinel');
    expect(bodyText).not.toContain('apiToken');
  });

  it('returns 404 for unknown settings group', async () => {
    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'unknown' }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Unknown settings group');
  });

  it('returns 401 on auth failure', async () => {
    const { ApiAuthError } = await import('@/src/lib/api-auth');
    mockRequireApiAdmin.mockRejectedValue(new ApiAuthError('Unauthorized', 401));

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'general' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('PUT /api/v1/settings/[group]', () => {
  it('saves general settings and applies caddy config', async () => {
    mockSaveGeneral.mockResolvedValue(undefined);

    const body = { defaultDomain: 'updated.example.com' };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'general' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveGeneral).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });

  it('saves default response settings and applies the Caddy config', async () => {
    const body = {
      mode: 'respond',
      status: 418,
      body: 'CPM_DEFAULT_RESPONSE',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    };
    mockSaveDefaultResponse.mockResolvedValue(undefined);

    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'default-response' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockSaveDefaultResponse).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });

  it('returns 400 when default response validation fails', async () => {
    mockSaveDefaultResponse.mockRejectedValueOnce(
      new DefaultResponseValidationError('defaultResponseStatusInvalid'),
    );

    const response = await PUT(
      createMockRequest({ method: 'PUT', body: { mode: 'respond', status: 103 } }),
      {
        params: Promise.resolve({ group: 'default-response' }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Default response status must be an integer from 200 to 599',
    });
    expect(mockApplyCaddyConfig).not.toHaveBeenCalled();
  });

  it('returns 500 when storing default response settings fails', async () => {
    mockSaveDefaultResponse.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await PUT(createMockRequest({ method: 'PUT', body: { mode: 'abort' } }), {
      params: Promise.resolve({ group: 'default-response' }),
    });

    expect(response.status).toBe(500);
    expect(mockApplyCaddyConfig).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown settings group', async () => {
    const response = await PUT(createMockRequest({ method: 'PUT', body: {} }), {
      params: Promise.resolve({ group: 'unknown' }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Unknown settings group');
  });

  it('returns 502 and restores the exact stored value if Caddy rejects the update', async () => {
    const previous = { defaultDomain: 'old.example.com', acmeEmail: 'old@example.com' };
    mockGetSetting.mockResolvedValue(previous);
    mockSaveGeneral.mockResolvedValue(undefined);
    mockApplyCaddyConfig
      .mockRejectedValueOnce(new Error('caddy rejected secret internal details'))
      .mockResolvedValueOnce({ ok: true } as any);

    const response = await PUT(
      createMockRequest({ method: 'PUT', body: { defaultDomain: 'new.example.com' } }),
      { params: Promise.resolve({ group: 'general' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data).toEqual({
      error: 'Failed to apply Caddy configuration; settings were rolled back',
    });
    expect(JSON.stringify(data)).not.toContain('secret internal details');
    expect(mockSetSetting).toHaveBeenCalledWith('general', previous);
    expect(mockApplyCaddyConfig).toHaveBeenCalledTimes(2);
  });

  it('clears a newly created setting if its first Caddy apply fails', async () => {
    mockGetSetting.mockResolvedValue(null);
    mockApplyCaddyConfig.mockRejectedValueOnce(new Error('caddy down'));

    const response = await PUT(
      createMockRequest({ method: 'PUT', body: { enabled: true, port: 9090 } }),
      {
        params: Promise.resolve({ group: 'metrics' }),
      },
    );

    expect(response.status).toBe(502);
    expect(mockClearSetting).toHaveBeenCalledWith('metrics');
  });

  it('reports a rollback failure instead of claiming the settings were restored', async () => {
    mockGetSetting.mockResolvedValue({ enabled: false, port: 9090 });
    mockApplyCaddyConfig.mockRejectedValueOnce(new Error('caddy down'));
    mockSetSetting.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await PUT(
      createMockRequest({ method: 'PUT', body: { enabled: true, port: 9090 } }),
      {
        params: Promise.resolve({ group: 'metrics' }),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to apply Caddy configuration and roll back settings',
    });
  });

  it('serializes updates so a failing rollback cannot overwrite a concurrent success', async () => {
    let rejectFirstApply!: (reason: Error) => void;
    const firstApply = new Promise<never>((_resolve, reject) => {
      rejectFirstApply = reject;
    });
    mockGetSetting.mockResolvedValue({ defaultDomain: 'old.example.com' });
    mockSaveGeneral.mockResolvedValue(undefined);
    mockApplyCaddyConfig
      .mockImplementationOnce(() => firstApply)
      .mockResolvedValueOnce({ ok: true } as any)
      .mockResolvedValueOnce({ ok: true } as any);

    const first = PUT(
      createMockRequest({
        method: 'PUT',
        body: { defaultDomain: 'first.example.com' },
      }),
      { params: Promise.resolve({ group: 'general' }) },
    );
    await vi.waitFor(() => expect(mockApplyCaddyConfig).toHaveBeenCalledTimes(1));

    const second = PUT(
      createMockRequest({
        method: 'PUT',
        body: { defaultDomain: 'second.example.com' },
      }),
      { params: Promise.resolve({ group: 'general' }) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSaveGeneral).toHaveBeenCalledTimes(1);
    rejectFirstApply(new Error('first apply failed'));

    expect((await first).status).toBe(502);
    expect((await second).status).toBe(200);
    expect(mockSaveGeneral).toHaveBeenNthCalledWith(2, {
      defaultDomain: 'second.example.com',
    });
    expect(mockApplyCaddyConfig).toHaveBeenCalledTimes(3);
  });

  it('shares the rollback lock with dashboard settings actions', async () => {
    let rejectApiApply!: (reason: Error) => void;
    const apiApply = new Promise<never>((_resolve, reject) => {
      rejectApiApply = reject;
    });
    mockGetSetting.mockResolvedValue({ defaultDomain: 'old.example.com' });
    mockSaveGeneral.mockResolvedValue(undefined);
    mockApplyCaddyConfig
      .mockImplementationOnce(() => apiApply)
      .mockResolvedValueOnce({ ok: true } as any);

    const apiUpdate = PUT(
      createMockRequest({
        method: 'PUT',
        body: { defaultDomain: 'api.example.com' },
      }),
      { params: Promise.resolve({ group: 'general' }) },
    );
    await vi.waitFor(() => expect(mockApplyCaddyConfig).toHaveBeenCalledTimes(1));

    const formData = new FormData();
    formData.set('defaultDomain', 'dashboard.example.com');
    const dashboardUpdate = updateGeneralSettingsAction(null, formData);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSaveGeneral).toHaveBeenCalledTimes(1);
    rejectApiApply(new Error('API apply failed'));

    expect((await apiUpdate).status).toBe(502);
    expect(await dashboardUpdate).toMatchObject({ success: true });
    expect(mockSaveGeneral).toHaveBeenNthCalledWith(2, {
      defaultDomain: 'dashboard.example.com',
      acmeEmail: undefined,
    });
  });

  it('rejects unknown settings fields before persistence or Caddy apply', async () => {
    const response = await PUT(
      createMockRequest({
        method: 'PUT',
        body: { enabled: true, port: 9090, injected: { handler: 'exec' } },
      }),
      { params: Promise.resolve({ group: 'metrics' }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'metrics settings contains unknown field: injected',
    });
    expect(mockSaveMetrics).not.toHaveBeenCalled();
    expect(mockApplyCaddyConfig).not.toHaveBeenCalled();
  });
});

describe('GET acme settings', () => {
  it('returns acme settings', async () => {
    const settings = { caUrl: 'https://ca.internal.example.com/acme/acme/directory' };
    mockGetAcme.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), { params: Promise.resolve({ group: 'acme' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetAcme).toHaveBeenCalled();
  });
});

describe('PUT acme settings', () => {
  it('saves acme settings and applies caddy config', async () => {
    mockSaveAcme.mockResolvedValue(undefined);

    const body = { caUrl: 'https://ca.internal.example.com/acme/acme/directory' };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'acme' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveAcme).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET cloudflare settings', () => {
  it('returns non-secret Cloudflare settings metadata', async () => {
    const settings = { apiToken: 'cf-token-xxx', zoneId: 'zone123', accountId: 'acc456' };
    mockGetCloudflare.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'cloudflare' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ hasApiToken: true, zoneId: 'zone123', accountId: 'acc456' });
    expect(mockGetCloudflare).toHaveBeenCalled();
  });
});

describe('PUT cloudflare settings', () => {
  it('saves cloudflare settings and applies caddy config', async () => {
    mockSaveCloudflare.mockResolvedValue(undefined);

    const body = { apiToken: 'new-token' };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'cloudflare' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveCloudflare).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET authentik settings', () => {
  it('returns authentik settings', async () => {
    const settings = {
      outpostDomain: 'auth.example.com',
      outpostUpstream: 'http://authentik:9000',
      authEndpoint: '/outpost.goauthentik.io/auth/caddy',
    };
    mockGetAuthentik.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'authentik' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetAuthentik).toHaveBeenCalled();
  });
});

describe('PUT authentik settings', () => {
  it('saves authentik settings and applies caddy config', async () => {
    mockSaveAuthentik.mockResolvedValue(undefined);

    const body = {
      outpostDomain: 'auth.example.com',
      outpostUpstream: 'http://authentik:9000',
      authEndpoint: '/outpost.goauthentik.io/auth/caddy',
    };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'authentik' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveAuthentik).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET forward-auth settings', () => {
  it('returns the forward auth defaults', async () => {
    const settings = {
      provider: 'authelia' as const,
      authUpstream: 'http://authelia:9091',
      authEndpoint: '/api/authz/forward-auth',
    };
    mockGetForwardAuth.mockResolvedValue(settings);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'forward-auth' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetForwardAuth).toHaveBeenCalled();
  });
});

describe('PUT forward-auth settings', () => {
  it('saves the forward auth defaults and applies caddy config', async () => {
    mockSaveForwardAuth.mockResolvedValue(undefined);

    const body = {
      provider: 'authelia',
      authUpstream: 'http://authelia:9091',
      authEndpoint: '/api/authz/forward-auth',
    };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'forward-auth' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveForwardAuth).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });

  it('rejects an auth server that is not an http(s) URL', async () => {
    const response = await PUT(
      createMockRequest({
        method: 'PUT',
        body: { provider: 'authelia', authUpstream: 'authelia:9091' },
      }),
      { params: Promise.resolve({ group: 'forward-auth' }) },
    );

    expect(response.status).toBe(400);
    expect(mockSaveForwardAuth).not.toHaveBeenCalled();
  });
});

describe('GET metrics settings', () => {
  it('returns metrics settings', async () => {
    const settings = { enabled: true, port: 9090 };
    mockGetMetrics.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'metrics' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetMetrics).toHaveBeenCalled();
  });
});

describe('PUT metrics settings', () => {
  it('saves metrics settings and applies caddy config', async () => {
    mockSaveMetrics.mockResolvedValue(undefined);

    const body = { enabled: false };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'metrics' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveMetrics).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET logging settings', () => {
  it('returns logging settings', async () => {
    const settings = { enabled: true, format: 'json' };
    mockGetLogging.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'logging' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetLogging).toHaveBeenCalled();
  });
});

describe('PUT logging settings', () => {
  it('saves logging settings and applies caddy config', async () => {
    mockSaveLogging.mockResolvedValue(undefined);

    const body = { enabled: true, format: 'console' };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'logging' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveLogging).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET dns settings', () => {
  it('returns dns settings', async () => {
    const settings = {
      enabled: true,
      resolvers: ['1.1.1.1', '9.9.9.9'],
      fallbacks: ['1.0.0.1', '149.112.112.112'],
      timeout: '5s',
    };
    mockGetDns.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), { params: Promise.resolve({ group: 'dns' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetDns).toHaveBeenCalled();
  });
});

describe('PUT dns settings', () => {
  it('saves dns settings and applies caddy config', async () => {
    mockSaveDns.mockResolvedValue(undefined);

    const body = {
      enabled: true,
      resolvers: ['1.1.1.1', '9.9.9.9'],
      fallbacks: ['1.0.0.1', '149.112.112.112'],
      timeout: '5s',
    };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'dns' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveDns).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET upstream-dns settings', () => {
  it('returns upstream-dns settings', async () => {
    const settings = { enabled: true, family: 'ipv4' };
    mockGetUpstreamDns.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'upstream-dns' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetUpstreamDns).toHaveBeenCalled();
  });
});

describe('PUT upstream-dns settings', () => {
  it('saves upstream-dns settings and applies caddy config', async () => {
    mockSaveUpstreamDns.mockResolvedValue(undefined);

    const body = { enabled: true, family: 'both' };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'upstream-dns' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveUpstreamDns).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET geoblock settings', () => {
  it('returns geoblock settings', async () => {
    const settings = {
      enabled: true,
      block_countries: ['CN'],
      block_continents: [],
      block_asns: [],
      block_cidrs: [],
      block_ips: [],
      allow_countries: ['FI'],
      allow_continents: [],
      allow_asns: [],
      allow_cidrs: [],
      allow_ips: [],
      trusted_proxies: ['private_ranges'],
      fail_closed: false,
      response_status: 403,
      response_body: 'Forbidden',
      response_headers: {},
      redirect_url: '',
    };
    mockGetGeoBlock.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'geoblock' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetGeoBlock).toHaveBeenCalled();
  });
});

describe('PUT geoblock settings', () => {
  it('saves geoblock settings and applies caddy config', async () => {
    mockSaveGeoBlock.mockResolvedValue(undefined);

    const body = {
      enabled: true,
      block_countries: ['CN'],
      block_continents: [],
      block_asns: [],
      block_cidrs: [],
      block_ips: [],
      allow_countries: ['FI'],
      allow_continents: [],
      allow_asns: [],
      allow_cidrs: [],
      allow_ips: [],
      trusted_proxies: ['private_ranges'],
      fail_closed: false,
      response_status: 403,
      response_body: 'Forbidden',
      response_headers: {},
      redirect_url: '',
    };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'geoblock' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveGeoBlock).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET waf settings', () => {
  it('returns waf settings', async () => {
    const settings = {
      enabled: true,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: '',
      excluded_rule_ids: [920350],
    };
    mockGetWaf.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), { params: Promise.resolve({ group: 'waf' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetWaf).toHaveBeenCalled();
  });
});

describe('PUT waf settings', () => {
  it('saves waf settings and applies caddy config', async () => {
    mockSaveWaf.mockResolvedValue(undefined);

    const body = {
      enabled: true,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: '',
      excluded_rule_ids: [920350],
    };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'waf' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveWaf).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});

describe('GET trusted-proxies settings', () => {
  it('returns trusted-proxies settings', async () => {
    const settings = {
      ranges: ['172.21.0.1/32'],
      client_ip_headers: ['Cf-Connecting-Ip'],
      strict: true,
      default_geoblock: false,
    };
    mockGetTrustedProxies.mockResolvedValue(settings as any);

    const response = await GET(createMockRequest(), {
      params: Promise.resolve({ group: 'trusted-proxies' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual(settings);
    expect(mockGetTrustedProxies).toHaveBeenCalled();
  });
});

describe('PUT trusted-proxies settings', () => {
  it('saves trusted-proxies settings and applies caddy config', async () => {
    mockSaveTrustedProxies.mockResolvedValue(undefined);

    const body = { ranges: ['private_ranges'], default_geoblock: true };
    const response = await PUT(createMockRequest({ method: 'PUT', body }), {
      params: Promise.resolve({ group: 'trusted-proxies' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockSaveTrustedProxies).toHaveBeenCalledWith(body);
    expect(mockApplyCaddyConfig).toHaveBeenCalled();
  });
});
