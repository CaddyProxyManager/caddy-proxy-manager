/**
 * The username step's check: a token the provider accepts buys a pass for that name, and nothing
 * else does.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const ctx = vi.hoisted(() => ({
  settings: {
    provider: 'turnstile' as string,
    siteKey: 'site',
    secretKey: 'secret',
    capInstanceUrl: '',
  },
}));

const actualSettings = await import('@/src/lib/captcha/settings');

vi.mock('@/src/lib/captcha/settings', () => ({
  ...actualSettings,
  getCaptchaSettings: async () => ctx.settings,
  captchaSecret: () => 'secret',
}));

vi.mock('@/src/lib/http/public-url', () => ({
  getPublicBaseUrl: async () => 'https://cpm.example.com',
}));

import { POST } from '@/src/app/api/sign-in/captcha/route';
import { CAPTCHA_PASS_COOKIE, isValidCaptchaPass } from '@/src/lib/captcha/pass';
import { resetWindows } from '@/src/lib/auth/rate-limit';

let fetchSpy: ReturnType<typeof spyOn>;
let verdict: unknown;

function check(body: unknown, ip = '203.0.113.7') {
  return POST(
    new Request('http://localhost:3000/api/sign-in/captcha', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
}

function passFrom(response: Response): string | null {
  const cookie = response.headers.get('set-cookie') ?? '';
  return cookie.match(new RegExp(`${CAPTCHA_PASS_COOKIE}=([^;]+)`))?.[1] ?? null;
}

beforeEach(() => {
  ctx.settings = {
    provider: 'turnstile',
    siteKey: 'site',
    secretKey: 'secret',
    capInstanceUrl: '',
  };
  verdict = { success: true };
  resetWindows('captcha:');
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
    Response.json(verdict)) as unknown as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('POST /api/sign-in/captcha', () => {
  it('issues a pass for the name a solved token was sent with', async () => {
    const response = await check({ username: 'alice', token: 'tok' });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api;');
    expect(cookie).toContain('Secure');
    expect(isValidCaptchaPass(passFrom(response), 'alice')).toBe(true);
    expect(isValidCaptchaPass(passFrom(response), 'bob')).toBe(false);
  });

  it('issues nothing for a token the provider rejects', async () => {
    verdict = { success: false, 'error-codes': ['invalid-input-response'] };
    const response = await check({ username: 'alice', token: 'tok' });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('CAPTCHA_FAILED');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('says so when the provider cannot be asked', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    const response = await check({ username: 'alice', token: 'tok' });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('CAPTCHA_UNAVAILABLE');
  });

  it('refuses a request with no name, without asking the provider', async () => {
    const response = await check({ token: 'tok' });
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 404 while no CAPTCHA is configured', async () => {
    ctx.settings = { ...ctx.settings, provider: 'none' };
    const response = await check({ username: 'alice', token: 'tok' });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('limits how many checks one address can drive', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) last = await check({ username: 'alice', token: `t${i}` });
    expect(last?.status).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(30);
    expect((await check({ username: 'alice', token: 'x' }, '198.51.100.1')).status).toBe(200);
  });
});
