import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';

// The action's messages come from the catalog, and getTranslations has no request scope here.
vi.mock('next-intl/server', () => nextIntlServerMock());

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/src/lib/auth', () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: '1' } })),
}));

type UpdateProxyHostMock = (id: number, input: unknown, userId: number) => Promise<object>;

const { listProxyHostsMock, updateProxyHostMock } = vi.hoisted(() => ({
  listProxyHostsMock: vi.fn(async () => [] as unknown[]),
  // Mirrors updateProxyHost's signature so mock.calls keeps the arg tuple.
  updateProxyHostMock: vi.fn<UpdateProxyHostMock>(async () => ({})),
}));

vi.mock('@/src/lib/models/proxy-hosts', () => ({
  listProxyHosts: listProxyHostsMock,
  updateProxyHost: updateProxyHostMock,
}));

vi.mock('@/src/lib/settings', () => ({
  clearSetting: vi.fn(),
  getSetting: vi.fn(),
  saveCloudflareSettings: vi.fn(),
  getDnsProviderSettings: vi.fn(),
  saveDnsProviderSettings: vi.fn(),
  saveGeneralSettings: vi.fn(),
  saveAuthentikSettings: vi.fn(),
  saveMetricsSettings: vi.fn(),
  saveLoggingSettings: vi.fn(),
  saveDnsSettings: vi.fn(),
  saveUpstreamDnsResolutionSettings: vi.fn(),
  saveGeoBlockSettings: vi.fn(),
  saveWafSettings: vi.fn(),
  getWafSettings: vi.fn(),
}));
vi.mock('@/src/lib/models/waf-events', () => ({
  getWafRuleMessages: vi.fn(),
}));
vi.mock('@/src/lib/dns/providers', () => ({
  getProviderDefinition: vi.fn(),
  // The module registry reads this at module scope, though this test never reaches DNS code.
  DNS_PROVIDERS: [],
}));
vi.mock('@/src/lib/dns/provider-credentials', () => ({
  encryptProviderCredentials: vi.fn(),
  encryptDnsProviderSettingCredentials: vi.fn(),
}));

import { suppressWafRuleForHostAction } from '@/src/app/(dashboard)/settings/actions';

beforeEach(() => {
  updateProxyHostMock.mockClear();
  listProxyHostsMock.mockClear();
});

describe('suppressWafRuleForHostAction port normalization', () => {
  const fakeHost = {
    id: 42,
    domains: ['app.example.com'],
    waf: { enabled: true, waf_mode: 'merge' as const, excluded_rule_ids: [] as number[] },
  };

  it('matches a host when the hostname has no port', async () => {
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com');
    expect(result.success).toBe(true);
    expect(updateProxyHostMock).toHaveBeenCalledTimes(1);
    expect(updateProxyHostMock.mock.calls[0]![0]).toBe(42);
  });

  it('matches a host when the hostname includes :443 (regression)', async () => {
    // Coraza records Host verbatim, port included ("app.example.com:443"), while host.domains holds
    // bare names, so the action must strip the port.
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com:443');
    expect(result.success).toBe(true);
    expect(updateProxyHostMock).toHaveBeenCalledTimes(1);
    expect(updateProxyHostMock.mock.calls[0]![0]).toBe(42);
  });

  it('matches a host when the hostname includes an arbitrary port', async () => {
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com:8443');
    expect(result.success).toBe(true);
    expect(updateProxyHostMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ waf: expect.objectContaining({ excluded_rule_ids: [941100] }) }),
      1,
    );
  });

  it('returns an error when no host matches even after port stripping', async () => {
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    const result = await suppressWafRuleForHostAction(941100, 'other.example.com:443');
    expect(result.success).toBe(false);
    expect(result.message).toContain('No proxy host found');
    expect(updateProxyHostMock).not.toHaveBeenCalled();
  });

  it('appends to existing excluded_rule_ids without duplicating', async () => {
    listProxyHostsMock.mockResolvedValueOnce([
      {
        ...fakeHost,
        waf: { enabled: true, waf_mode: 'merge' as const, excluded_rule_ids: [941100, 920100] },
      },
    ]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com:443');
    expect(result.success).toBe(true);
    const updateArg = updateProxyHostMock.mock.calls[0]![1] as {
      waf: { excluded_rule_ids: number[] };
    };
    expect(updateArg.waf.excluded_rule_ids.sort()).toEqual([920100, 941100]);
  });
});
