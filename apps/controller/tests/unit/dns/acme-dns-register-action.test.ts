/**
 * The Register button: one outbound call, then the account, the acme-dns provider and a
 * delegation land in the dns_provider blob together, and the one CNAME to create comes back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { outboundViaGlobalFetch } from '@/tests/helpers/outbound';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import type { DnsProviderSettings } from '@/src/lib/settings';

vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: '1' } })),
}));

const { getDnsMock, saveDnsMock } = vi.hoisted(() => ({
  getDnsMock: vi.fn<() => Promise<DnsProviderSettings | null>>(async () => null),
  saveDnsMock: vi.fn<(settings: DnsProviderSettings) => Promise<void>>(async () => {}),
}));

vi.mock('@/src/lib/settings', () => ({
  clearSetting: vi.fn(),
  getSetting: vi.fn(),
  getDnsProviderSettings: getDnsMock,
  saveDnsProviderSettings: saveDnsMock,
}));
vi.mock('@/src/lib/settings/staging', () => ({
  discardAllStaged: vi.fn(),
  discardStagedKey: vi.fn(),
  stageWrites: vi.fn(async () => {}),
  stagedOverlay: vi.fn(async () => new Map()),
}));
vi.mock('@/src/lib/settings/staging-context', () => ({
  withCapturedWrites: async (_overlay: unknown, action: () => Promise<unknown>) => ({
    result: await action(),
    writes: new Map(),
  }),
}));
vi.mock('@/src/lib/caddy', () => ({ applyCaddyConfig: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/src/lib/http/outbound', outboundViaGlobalFetch);

import { registerAcmeDnsAccountAction } from '@/src/app/(dashboard)/settings/actions';

const realFetch = globalThis.fetch;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function form(domain: string, serverUrl: string): FormData {
  const data = new FormData();
  data.set('domain', domain);
  data.set('serverUrl', serverUrl);
  return data;
}

beforeEach(() => {
  fetchMock.mockReset();
  saveDnsMock.mockClear();
  getDnsMock.mockResolvedValue({
    providers: { cloudflare: { api_token: 'x' } },
    default: 'cloudflare',
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('registerAcmeDnsAccountAction', () => {
  it('stores the account, adds the provider and a delegation, and returns the CNAME', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { username: 'u', password: 'p', subdomain: 's', fulldomain: 's.auth.example.net' },
        { status: 201 },
      ),
    );
    const result = await registerAcmeDnsAccountAction(
      null,
      form('*.Example.com', 'https://auth.example.net'),
    );

    expect(result.success).toBe(true);
    expect(result.cname).toEqual({
      name: '_acme-challenge.example.com',
      target: 's.auth.example.net',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://auth.example.net/register');
    const saved = saveDnsMock.mock.calls[0][0];
    expect(saved.default).toBe('cloudflare');
    expect(saved.providers.acmedns).toEqual({});
    expect(saved.acmeDnsAccounts?.['example.com']).toMatchObject({
      username: 'u',
      fulldomain: 's.auth.example.net',
      server_url: 'https://auth.example.net',
    });
    expect(saved.delegations).toEqual([
      { domain: 'example.com', target: null, provider: 'acmedns' },
    ]);
  });

  it('saves nothing when the server answers with something other than an account', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 201 }));
    const result = await registerAcmeDnsAccountAction(
      null,
      form('example.com', 'https://auth.example.net'),
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/was not an account/);
    expect(saveDnsMock).not.toHaveBeenCalled();
  });

  it('refuses plain http to a public host without calling it', async () => {
    const result = await registerAcmeDnsAccountAction(
      null,
      form('example.com', 'http://auth.example.net'),
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/must use HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveDnsMock).not.toHaveBeenCalled();
  });

  it('requires a server URL rather than defaulting to a public one', async () => {
    const result = await registerAcmeDnsAccountAction(null, form('example.com', ''));
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
