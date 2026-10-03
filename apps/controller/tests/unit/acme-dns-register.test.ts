/**
 * The register call goes to an admin-supplied URL, so it is bounded: https unless local, no
 * redirects, a size cap and a shape check before anything is stored.
 */
import { describe, expect, it } from 'bun:test';
import { parseAcmeDnsServerUrl, registerAcmeDnsAccount } from '@/src/lib/acme-dns';
import { isLocalHost } from '@/src/lib/outbound-url';
import { DomainError } from '@/src/lib/domain-error';

const ACCOUNT = {
  username: 'c36f50e8-4632-44f0-83fe-e070fef28a10',
  password: 'htB9mR9DYgcu9bX_afHF62erXaH2TS7bg9KW3F7Z',
  fulldomain: 'd420c923-bbd7-4056-ab64-c3ca54c9b3cf.auth.example.org',
  subdomain: 'd420c923-bbd7-4056-ab64-c3ca54c9b3cf',
  allowfrom: [],
};

function fakeFetch(response: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).code;
  }
  return undefined;
}

describe('registerAcmeDnsAccount', () => {
  it('posts to /register and keeps only the account fields', async () => {
    const { impl, calls } = fakeFetch(() => Response.json(ACCOUNT, { status: 201 }));
    const account = await registerAcmeDnsAccount('https://auth.example.org/', impl);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://auth.example.org/register');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.redirect).toBe('manual');
    expect(account).toEqual({
      username: ACCOUNT.username,
      password: ACCOUNT.password,
      subdomain: ACCOUNT.subdomain,
      fulldomain: ACCOUNT.fulldomain,
      server_url: 'https://auth.example.org',
    });
  });

  it('refuses a non-https URL to a public host before any request', async () => {
    const { impl, calls } = fakeFetch(() => Response.json(ACCOUNT, { status: 201 }));
    expect(await codeOf(registerAcmeDnsAccount('http://auth.example.org', impl))).toBe(
      'acmeDnsServerUrlHttps',
    );
    expect(await codeOf(registerAcmeDnsAccount('file:///etc/passwd', impl))).toBe(
      'acmeDnsServerUrlInvalid',
    );
    expect(await codeOf(registerAcmeDnsAccount('https://user:pw@auth.example.org', impl))).toBe(
      'acmeDnsServerUrlInvalid',
    );
    expect(calls).toHaveLength(0);
  });

  it('allows plain http to a local server', async () => {
    const { impl, calls } = fakeFetch(() => Response.json(ACCOUNT, { status: 201 }));
    await registerAcmeDnsAccount('http://acme-dns:8080', impl);
    await registerAcmeDnsAccount('http://192.168.1.10', impl);
    expect(calls.map((call) => call.url)).toEqual([
      'http://acme-dns:8080/register',
      'http://192.168.1.10/register',
    ]);
  });

  it('refuses an answer that is not JSON, or not an account', async () => {
    const notJson = fakeFetch(() => new Response('<html>', { status: 201 }));
    expect(await codeOf(registerAcmeDnsAccount('https://auth.example.org', notJson.impl))).toBe(
      'acmeDnsRegisterInvalidResponse',
    );
    const missing = fakeFetch(() => Response.json({ username: 'x' }, { status: 201 }));
    expect(await codeOf(registerAcmeDnsAccount('https://auth.example.org', missing.impl))).toBe(
      'acmeDnsRegisterInvalidResponse',
    );
    const badDomain = fakeFetch(() =>
      Response.json({ ...ACCOUNT, fulldomain: '{env.X}.example.org' }, { status: 201 }),
    );
    expect(await codeOf(registerAcmeDnsAccount('https://auth.example.org', badDomain.impl))).toBe(
      'acmeDnsRegisterInvalidResponse',
    );
  });

  it('refuses an oversized answer, declared or streamed', async () => {
    const big = JSON.stringify({ ...ACCOUNT, padding: 'x'.repeat(20_000) });
    const streamed = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(big));
              controller.close();
            },
          }),
          { status: 201 },
        ),
    );
    expect(await codeOf(registerAcmeDnsAccount('https://auth.example.org', streamed.impl))).toBe(
      'acmeDnsRegisterTooLarge',
    );
    const declared = fakeFetch(
      () => new Response('{}', { status: 201, headers: { 'content-length': '999999' } }),
    );
    expect(await codeOf(registerAcmeDnsAccount('https://auth.example.org', declared.impl))).toBe(
      'acmeDnsRegisterTooLarge',
    );
  });

  it('reports a refusal, a redirect and an unreachable server', async () => {
    const refused = fakeFetch(() => new Response('no', { status: 403 }));
    expect(await codeOf(registerAcmeDnsAccount('https://auth.example.org', refused.impl))).toBe(
      'acmeDnsRegisterStatus',
    );
    const redirect = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    expect(await codeOf(registerAcmeDnsAccount('https://auth.example.org', redirect.impl))).toBe(
      'acmeDnsRegisterStatus',
    );
    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await codeOf(registerAcmeDnsAccount('https://auth.example.org', unreachable))).toBe(
      'acmeDnsRegisterUnreachable',
    );
  });
});

describe('isLocalHost', () => {
  it('accepts loopback, private, link-local and single-label hosts only', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.0.1',
      '[::1]',
      '[fd00::1]',
      'localhost',
      'acme-dns',
    ]) {
      expect(isLocalHost(host)).toBe(true);
    }
    for (const host of ['8.8.8.8', '172.32.0.1', '[2001:db8::1]', 'auth.acme-dns.io']) {
      expect(isLocalHost(host)).toBe(false);
    }
  });

  it('normalizes the base URL', () => {
    expect(parseAcmeDnsServerUrl(' https://auth.example.org/acme/ ')).toBe(
      'https://auth.example.org/acme',
    );
  });
});
