/** Each branch is a different fix for the operator, so the reasons must stay distinguishable. */
import { describe, it, expect } from 'bun:test';

import { checkTailscaleAuthKey } from '@/src/lib/caddy/tailscale-api';
import { isCaddyPlaceholder, tailscaleKeyId } from '@/src/lib/caddy/tailscale';

const KEY = 'tskey-auth-abcDEF1CNTRL-091234567890ABCDEF';
const TOKEN = 'tskey-api-zzzYYY2CNTRL-000000000000000000';

/** A fetch that answers once with the given status/body, and records what it was asked. */
function fakeFetch(response: { status: number; body?: unknown; throws?: Error }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (response.throws) throw response.throws;
    return new Response(response.body === undefined ? '' : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const check = (overrides: Partial<Parameters<typeof checkTailscaleAuthKey>[0]> = {}) =>
  checkTailscaleAuthKey({
    authKey: KEY,
    apiAccessToken: TOKEN,
    tailnet: '-',
    ...overrides,
  });

describe('tailscaleKeyId', () => {
  it('takes the id segment out of a tskey-<type>-<id>-<secret> key', () => {
    expect(tailscaleKeyId(KEY)).toBe('abcDEF1CNTRL');
    expect(tailscaleKeyId(TOKEN)).toBe('zzzYYY2CNTRL');
  });

  it('returns null for anything without that shape', () => {
    // Null is "cannot check", not "invalid": older and Headscale keys work without an id.
    expect(tailscaleKeyId('tskey-abcdef1432341818')).toBeNull();
    expect(tailscaleKeyId('{env.TS_AUTHKEY}')).toBeNull();
    expect(tailscaleKeyId('')).toBeNull();
    expect(tailscaleKeyId('notakey-auth-a-b')).toBeNull();
  });
});

describe('isCaddyPlaceholder', () => {
  it('spots a value Caddy expands at load time', () => {
    expect(isCaddyPlaceholder('{env.TS_AUTHKEY}')).toBe(true);
    expect(isCaddyPlaceholder(KEY)).toBe(false);
  });
});

describe('checkTailscaleAuthKey', () => {
  it('addresses the key by id, on the requested tailnet, with the token as a bearer', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { id: 'abcDEF1CNTRL' } });
    expect(await check({ fetchImpl: impl, tailnet: 'example.com' })).toEqual({ status: 'ok' });
    expect(calls[0].url).toBe(
      'https://api.tailscale.com/api/v2/tailnet/example.com/keys/abcDEF1CNTRL',
    );
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('accepts a key that is present and not revoked', async () => {
    const { impl } = fakeFetch({
      status: 200,
      body: { id: 'abcDEF1CNTRL', expires: '2999-01-01T00:00:00Z' },
    });
    expect(await check({ fetchImpl: impl })).toEqual({ status: 'ok' });
  });

  it('rejects a revoked key', async () => {
    const { impl } = fakeFetch({
      status: 200,
      body: { id: 'abcDEF1CNTRL', revoked: '2020-01-01T00:00:00Z' },
    });
    const result = await check({ fetchImpl: impl });
    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && result.error.message).toMatch(/revoked/i);
  });

  it('rejects a key marked invalid', async () => {
    const { impl } = fakeFetch({ status: 200, body: { id: 'abcDEF1CNTRL', invalid: true } });
    expect((await check({ fetchImpl: impl })).status).toBe('rejected');
  });

  it('rejects a key whose expiry has passed', async () => {
    // Some tailnets report this only through the timestamp, never through `invalid`.
    const { impl } = fakeFetch({
      status: 200,
      body: { id: 'abcDEF1CNTRL', expires: '2020-01-01T00:00:00Z' },
    });
    const result = await check({ fetchImpl: impl });
    expect(result.status === 'rejected' && result.error.message).toMatch(/expired/i);
  });

  it('blames the token, not the key, on a 401', async () => {
    const { impl } = fakeFetch({ status: 401 });
    const result = await check({ fetchImpl: impl });
    expect(result.status === 'rejected' && result.error.message).toMatch(/access token/i);
    expect(result.status === 'rejected' && result.error.message).toMatch(
      /says nothing about the auth key/,
    );
  });

  it('names the tailnet on a 404, since a key can simply belong to another one', async () => {
    const { impl } = fakeFetch({ status: 404 });
    const result = await check({ fetchImpl: impl, tailnet: 'other.example' });
    expect(result.status === 'rejected' && result.error.message).toMatch(/other\.example/);
  });

  it('refuses rather than guessing when the API cannot be reached', async () => {
    // Not "ok": passing an unreachable API would defeat the check. The message names the way out.
    const { impl } = fakeFetch({ status: 0, throws: new Error('getaddrinfo ENOTFOUND') });
    const result = await check({ fetchImpl: impl });
    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && result.error.message).toMatch(/turn the check off/);
  });

  it('cannot check a Caddy placeholder, and says so instead of failing', async () => {
    const { impl, calls } = fakeFetch({ status: 200 });
    const result = await check({ authKey: '{env.TS_AUTHKEY}', fetchImpl: impl });
    expect(result.status).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('cannot check a key with no id, and says so instead of failing', async () => {
    const { impl, calls } = fakeFetch({ status: 200 });
    const result = await check({ authKey: 'tskey-abcdef1432341818', fetchImpl: impl });
    expect(result.status).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('rejects when the check is on but no API token is stored', async () => {
    const { impl, calls } = fakeFetch({ status: 200 });
    const result = await check({ apiAccessToken: '', fetchImpl: impl });
    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && result.error.message).toMatch(/tskey-api/);
    expect(calls).toHaveLength(0);
  });
});
