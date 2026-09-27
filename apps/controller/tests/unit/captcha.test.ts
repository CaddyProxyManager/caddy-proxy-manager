/**
 * The sign-in CAPTCHA: the pass the username step issues, the provider check behind it, and the
 * CSP the sign-in page is given to load the widget.
 */
import { describe, expect, it } from 'bun:test';
import {
  CAPTCHA_PASS_COOKIE,
  CAPTCHA_PASS_TTL_MS,
  captchaPassFromCookieHeader,
  isValidCaptchaPass,
  issueCaptchaPass,
  redeemCaptchaPass,
  restartCaptchaPasses,
} from '@/src/lib/captcha/pass';
import { captchaCspSources, capSiteUrl } from '@/src/lib/captcha/providers';
import { activeCaptcha, DEFAULT_CAPTCHA_SETTINGS } from '@/src/lib/captcha/settings';
import { type CaptchaCheck, verifyCaptchaToken } from '@/src/lib/captcha/verify';
import { buildCsp, cspNonce } from '@/src/lib/csp';
import { parseCpmForwardAuthConfig } from '@/src/lib/proxy-host-form';

describe('captcha pass', () => {
  const now = 1_800_000_000_000;

  it('holds for the name it was solved for, however it is cased', () => {
    const pass = issueCaptchaPass('Alice', now);
    expect(isValidCaptchaPass(pass, 'alice', now)).toBe(true);
    expect(isValidCaptchaPass(pass, ' ALICE ', now + 1000)).toBe(true);
    // The username and its local email are one account to the throttle, and to this.
    expect(isValidCaptchaPass(pass, 'alice@localhost', now)).toBe(true);
  });

  it('never matches a blank name', () => {
    const pass = issueCaptchaPass('@localhost', now);
    expect(isValidCaptchaPass(pass, '', now)).toBe(false);
    expect(redeemCaptchaPass(pass, '  ', now)).toBe(false);
    expect(redeemCaptchaPass(pass, '@localhost', now)).toBe(true);
  });

  it('does not carry over to another name', () => {
    expect(isValidCaptchaPass(issueCaptchaPass('alice', now), 'bob', now)).toBe(false);
  });

  it('expires', () => {
    const pass = issueCaptchaPass('alice', now);
    expect(isValidCaptchaPass(pass, 'alice', now + CAPTCHA_PASS_TTL_MS)).toBe(false);
  });

  it('refuses a tampered or forged pass', () => {
    const pass = issueCaptchaPass('alice', now);
    const [expiry, nonce, sig] = pass.split('.');
    expect(isValidCaptchaPass(`${Number(expiry) + 1}.${nonce}.${sig}`, 'alice', now)).toBe(false);
    expect(isValidCaptchaPass(`${expiry}.x${nonce}.${sig}`, 'alice', now)).toBe(false);
    expect(isValidCaptchaPass(`${expiry}.${nonce}.${sig?.slice(1)}x`, 'alice', now)).toBe(false);
    // The shape before passes carried a nonce.
    expect(isValidCaptchaPass(`${expiry}.${sig}`, 'alice', now)).toBe(false);
    expect(isValidCaptchaPass(`${pass}.extra`, 'alice', now)).toBe(false);
    expect(isValidCaptchaPass('', 'alice', now)).toBe(false);
    expect(isValidCaptchaPass(null, 'alice', now)).toBe(false);
  });

  it('refuses one dated further out than a pass is ever issued for', () => {
    // Signed by us, but only a stolen key could have produced it: there is no issuing path.
    const later = issueCaptchaPass('alice', now + CAPTCHA_PASS_TTL_MS);
    expect(isValidCaptchaPass(later, 'alice', now - 1)).toBe(false);
  });

  it('admits one attempt, however many requests replay it', () => {
    const pass = issueCaptchaPass('alice', now);
    expect(redeemCaptchaPass(pass, 'alice', now)).toBe(true);
    expect(redeemCaptchaPass(pass, 'alice', now)).toBe(false);
    expect(isValidCaptchaPass(pass, 'alice', now)).toBe(false);
    expect(redeemCaptchaPass(issueCaptchaPass('alice', now), 'alice', now)).toBe(true);
  });

  it('does not survive a restart, which forgets what was spent', () => {
    const pass = issueCaptchaPass('alice', now);
    expect(redeemCaptchaPass(pass, 'alice', now)).toBe(true);
    restartCaptchaPasses();
    expect(redeemCaptchaPass(pass, 'alice', now)).toBe(false);
    // Only what was minted before: a pass issued after the restart is good.
    expect(redeemCaptchaPass(issueCaptchaPass('alice', now), 'alice', now)).toBe(true);
  });

  it('is not spent by a redemption for another name', () => {
    const pass = issueCaptchaPass('alice', now);
    expect(redeemCaptchaPass(pass, 'bob', now)).toBe(false);
    expect(redeemCaptchaPass(pass, 'alice', now)).toBe(true);
  });

  it('is read from a Cookie header among others', () => {
    const header = `a=1; ${CAPTCHA_PASS_COOKIE}=123.abc=; b=2`;
    expect(captchaPassFromCookieHeader(header)).toBe('123.abc=');
    expect(captchaPassFromCookieHeader('a=1')).toBeNull();
    expect(captchaPassFromCookieHeader(null)).toBeNull();
  });
});

type Call = { url: string; init: RequestInit };

function fakeFetch(answer: Response | (() => Response) | Error) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer.clone();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const check = (provider: CaptchaCheck['provider']): CaptchaCheck => ({
  provider,
  siteKey: 'site-key',
  secret: 'shh',
  capInstanceUrl: provider === 'cap' ? 'https://cap.example.com/' : undefined,
});

describe('verifyCaptchaToken', () => {
  it.each([
    ['recaptcha', 'https://www.google.com/recaptcha/api/siteverify'],
    ['hcaptcha', 'https://api.hcaptcha.com/siteverify'],
    ['turnstile', 'https://challenges.cloudflare.com/turnstile/v0/siteverify'],
  ] as const)('posts a %s token to its siteverify as a form', async (provider, url) => {
    const { calls, impl } = fakeFetch(Response.json({ success: true }));
    expect(await verifyCaptchaToken(check(provider), 'tok', '203.0.113.9', impl)).toBe('passed');
    expect(calls[0]?.url).toBe(url);
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(body.get('secret')).toBe('shh');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('203.0.113.9');
    expect(body.get('sitekey')).toBe(provider === 'hcaptcha' ? 'site-key' : null);
  });

  it("posts a Cap token as JSON to the site key's own siteverify", async () => {
    const { calls, impl } = fakeFetch(Response.json({ success: true }));
    expect(await verifyCaptchaToken(check('cap'), 'tok', null, impl)).toBe('passed');
    expect(calls[0]?.url).toBe('https://cap.example.com/site-key/siteverify');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ secret: 'shh', response: 'tok' });
  });

  it('fails a token the provider rejects', async () => {
    const { impl } = fakeFetch(
      Response.json({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    expect(await verifyCaptchaToken(check('turnstile'), 'tok', null, impl)).toBe('failed');
  });

  it('treats success as a boolean, not a truthy value', async () => {
    const { impl } = fakeFetch(Response.json({ success: 'true' }));
    expect(await verifyCaptchaToken(check('recaptcha'), 'tok', null, impl)).toBe('failed');
  });

  it('reports a bad secret, an error status or no answer as unavailable', async () => {
    const badSecret = fakeFetch(
      Response.json({ success: false, 'error-codes': ['invalid-input-secret'] }),
    );
    expect(await verifyCaptchaToken(check('hcaptcha'), 'tok', null, badSecret.impl)).toBe(
      'unavailable',
    );
    const down = fakeFetch(() => new Response('nope', { status: 502 }));
    expect(await verifyCaptchaToken(check('recaptcha'), 'tok', null, down.impl)).toBe(
      'unavailable',
    );
    const offline = fakeFetch(new Error('ECONNREFUSED'));
    expect(await verifyCaptchaToken(check('cap'), 'tok', null, offline.impl)).toBe('unavailable');
  });

  it('never asks about an empty or oversized token', async () => {
    const { calls, impl } = fakeFetch(Response.json({ success: true }));
    expect(await verifyCaptchaToken(check('turnstile'), '', null, impl)).toBe('failed');
    expect(await verifyCaptchaToken(check('turnstile'), 'x'.repeat(9000), null, impl)).toBe(
      'failed',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('activeCaptcha', () => {
  const configured = { ...DEFAULT_CAPTCHA_SETTINGS, siteKey: 'site', secretKey: 'secret' };

  it('is off until a provider has both keys', () => {
    expect(activeCaptcha(DEFAULT_CAPTCHA_SETTINGS)).toBeNull();
    expect(activeCaptcha({ ...configured, provider: 'turnstile', secretKey: '' })).toBeNull();
    expect(activeCaptcha({ ...configured, provider: 'turnstile', siteKey: '' })).toBeNull();
    expect(activeCaptcha({ ...configured, provider: 'turnstile' })).toEqual({
      provider: 'turnstile',
      siteKey: 'site',
    });
  });

  it('needs an instance for Cap, and never hands out the secret', () => {
    expect(activeCaptcha({ ...configured, provider: 'cap' })).toBeNull();
    const cap = activeCaptcha({
      ...configured,
      provider: 'cap',
      capInstanceUrl: 'https://cap.example.com',
    });
    expect(cap).toEqual({
      provider: 'cap',
      siteKey: 'site',
      capApiEndpoint: 'https://cap.example.com/site/',
    });
    expect(JSON.stringify(cap)).not.toContain('secret');
  });

  it('builds the Cap site URL whatever the trailing slashes', () => {
    expect(capSiteUrl('https://cap.example.com//', 'k')).toBe('https://cap.example.com/k/');
  });
});

describe('sign-in CSP', () => {
  it('is unchanged without a CAPTCHA', () => {
    expect(buildCsp('n')).not.toContain('frame-src');
    expect(buildCsp('n')).not.toContain('wasm-unsafe-eval');
  });

  it("opens the provider's origins and nothing broader", () => {
    const csp = buildCsp('n', captchaCspSources({ provider: 'turnstile', siteKey: 's' }));
    expect(csp).toContain("script-src 'self' 'nonce-n' https://challenges.cloudflare.com;");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com;');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('https:;');
  });

  it('lets Cap reach its own instance and run its WebAssembly', () => {
    const csp = buildCsp(
      'n',
      captchaCspSources({
        provider: 'cap',
        siteKey: 's',
        capApiEndpoint: 'https://cap.example.com:8443/s/',
      }),
    );
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain(
      "connect-src 'self' https://cdn.jsdelivr.net https://cap.example.com:8443;",
    );
  });

  it('gives the nonce back to the page', () => {
    expect(cspNonce(buildCsp('abc+/='))).toBe('abc+/=');
    expect(cspNonce(null)).toBeUndefined();
  });
});

describe('the per-host portal switch, from the host form', () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  const base = {
    cpmForwardAuthPresent: '1',
    cpmForwardAuthEnabledPresent: '1',
    cpmForwardAuthEnabled: 'on',
  };

  it('reads the switch when the form drew it', () => {
    expect(
      parseCpmForwardAuthConfig(form({ ...base, cpmForwardAuthRequireCaptcha: 'false' }))
        ?.require_captcha,
    ).toBe(false);
    expect(
      parseCpmForwardAuthConfig(form({ ...base, cpmForwardAuthRequireCaptcha: 'on' }))
        ?.require_captcha,
    ).toBe(true);
  });

  it('leaves it out when the form did not, so the host keeps its value', () => {
    expect(parseCpmForwardAuthConfig(form(base))).not.toHaveProperty('require_captcha');
  });
});
