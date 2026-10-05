import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

// The model module imports audit; keep it inert for this unit test.
vi.mock('@/src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

const actualSettings = await import('@/src/lib/settings');

vi.mock('@/src/lib/settings', () => ({ ...actualSettings, getDnsProviderSettings: vi.fn() }));

import { assertWildcardIssuable } from '@/src/lib/models/proxy-hosts';
import { getDnsProviderSettings } from '@/src/lib/settings';
import { DomainError } from '@/src/lib/errors/domain-error';

const mockGetDnsProviderSettings = vi.mocked(getDnsProviderSettings);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertWildcardIssuable', () => {
  it('rejects an auto-managed wildcard host when no DNS provider is configured', async () => {
    mockGetDnsProviderSettings.mockResolvedValue(null);
    const failure = assertWildcardIssuable(['*.example.com'], null);
    // A 400 DomainError, so `/api/v1` answers as before and an action can translate it.
    await expect(failure).rejects.toBeInstanceOf(DomainError);
    await expect(failure).rejects.toMatchObject({
      code: 'wildcardDomainNeedsDnsProvider',
      status: 400,
      message: expect.stringMatching(/Wildcard domain "\*\.example\.com" requires a DNS provider/),
    });
  });

  it('rejects when a default is named but has no credentials', async () => {
    mockGetDnsProviderSettings.mockResolvedValue({ providers: {}, default: 'cloudflare' });
    await expect(assertWildcardIssuable(['*.example.com'], null)).rejects.toThrow(/DNS provider/);
  });

  it('allows an auto-managed wildcard host when a DNS provider is configured', async () => {
    mockGetDnsProviderSettings.mockResolvedValue({
      providers: { cloudflare: { api_token: 'x' } },
      default: 'cloudflare',
    });
    await expect(assertWildcardIssuable(['*.example.com'], null)).resolves.toBeUndefined();
  });

  it('allows a wildcard a delegation covers with its own provider, and no default', async () => {
    mockGetDnsProviderSettings.mockResolvedValue({
      providers: { acmedns: {} },
      default: null,
      delegations: [{ domain: 'example.com', provider: 'acmedns' }],
    });
    await expect(assertWildcardIssuable(['*.example.com'], null)).resolves.toBeUndefined();
    await expect(assertWildcardIssuable(['*.example.org'], null)).rejects.toMatchObject({
      code: 'wildcardDomainNeedsDnsProvider',
    });
  });

  it('skips the check entirely for non-wildcard domains', async () => {
    await assertWildcardIssuable(['app.example.com', 'example.com'], null);
    expect(mockGetDnsProviderSettings).not.toHaveBeenCalled();
  });

  it('skips the check when a certificate is explicitly assigned', async () => {
    await assertWildcardIssuable(['*.example.com'], 5);
    expect(mockGetDnsProviderSettings).not.toHaveBeenCalled();
  });
});
