/**
 * Test connection: the typed key, or the stored one only for the address it was saved for, and a
 * result worded for a LAPI the controller may not be able to reach.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { outboundViaGlobalFetch } from '@/tests/helpers/outbound';
import { nextIntlServerMock, testTranslator } from '@/tests/helpers/next-intl';
import { type CrowdSecSettings, DEFAULT_CROWDSEC_SETTINGS } from '@/src/lib/caddy/crowdsec';
import { encryptSecret } from '@/src/lib/secrets';

vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: '1' } })),
}));

const { getCrowdSecMock } = vi.hoisted(() => ({
  getCrowdSecMock: vi.fn<() => Promise<CrowdSecSettings>>(),
}));

vi.mock('@/src/lib/settings', () => ({
  clearSetting: vi.fn(),
  getSetting: vi.fn(),
  getCrowdSecSettings: getCrowdSecMock,
}));
vi.mock('@/src/lib/caddy', () => ({ applyCaddyConfig: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/src/lib/http/outbound', outboundViaGlobalFetch);

import { testCrowdSecConnectionAction } from '@/src/app/(dashboard)/settings/actions';

const t = testTranslator('settings.results');
const realFetch = globalThis.fetch;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function sentKey(): string | undefined {
  const init = fetchMock.mock.calls[0]?.[1];
  return (init?.headers as Record<string, string> | undefined)?.['X-Api-Key'];
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json(null));
  getCrowdSecMock.mockResolvedValue({
    ...DEFAULT_CROWDSEC_SETTINGS,
    enabled: true,
    apiUrl: 'http://crowdsec:8080',
    apiKey: encryptSecret('stored-key'),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('testCrowdSecConnectionAction', () => {
  it('tries the stored key against the address it was saved for', async () => {
    const result = await testCrowdSecConnectionAction({
      apiUrl: 'http://crowdsec:8080/',
      apiKey: '',
    });
    expect(result).toEqual({ success: true, message: t('crowdsecTestOk') });
    expect(sentKey()).toBe('stored-key');
  });

  it('never sends the stored key to another address', async () => {
    const result = await testCrowdSecConnectionAction({
      apiUrl: 'http://other:8080',
      apiKey: '',
    });
    expect(result).toEqual({ success: false, message: t('crowdsecTestNoKey') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers a typed key', async () => {
    await testCrowdSecConnectionAction({ apiUrl: 'http://other:8080', apiKey: 'typed' });
    expect(sentKey()).toBe('typed');
  });

  it('says the key was refused, or that Caddy may still reach what the controller cannot', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect(
      await testCrowdSecConnectionAction({ apiUrl: 'http://crowdsec:8080', apiKey: 'k' }),
    ).toEqual({ success: false, message: t('crowdsecTestRejected') });

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(
      await testCrowdSecConnectionAction({ apiUrl: 'http://crowdsec:8080', apiKey: 'k' }),
    ).toEqual({
      success: false,
      message: t('crowdsecTestUnreachable', { url: 'http://crowdsec:8080' }),
    });
  });

  it('refuses a public http address before any request', async () => {
    const result = await testCrowdSecConnectionAction({
      apiUrl: 'http://lapi.example.com',
      apiKey: 'k',
    });
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
