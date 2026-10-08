/**
 * The monitor asks an agent for the config's digest rather than the config. An older agent ignores
 * the flag and sends the body, which is hashed here to the same value.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { CADDY_DIGEST_HEADER } from '@cpm/shared';
import { type CaddyAdminRequest, setCaddyAdminTransport } from '@/src/lib/caddy/admin';
import { getCaddyLiveConfigHash } from '@/src/lib/caddy';

const CONFIG = JSON.stringify({ apps: { http: { servers: {} } } });
const HASH = createHash('sha256').update(CONFIG).digest('hex');

let restore: (() => void) | null = null;
afterEach(() => restore?.());

type Answer = { status: number; text: string; headers: Record<string, string> };

function answer(respond: () => Answer) {
  const asked: CaddyAdminRequest[] = [];
  const previous = setCaddyAdminTransport(async (request) => {
    asked.push(request);
    return respond();
  });
  restore = () => setCaddyAdminTransport(previous);
  return asked;
}

describe('getCaddyLiveConfigHash', () => {
  it('asks for the digest and takes one an agent sends as it is', async () => {
    const asked = answer(() => ({
      status: 200,
      text: HASH,
      headers: { [CADDY_DIGEST_HEADER]: 'sha256' },
    }));
    expect(await getCaddyLiveConfigHash('a1')).toBe(HASH);
    expect(asked[0]).toMatchObject({
      path: '/config/',
      method: 'GET',
      digest: true,
      agentId: 'a1',
    });
  });

  it('hashes the body an older agent sends instead, to the same value', async () => {
    answer(() => ({ status: 200, text: CONFIG, headers: {} }));
    expect(await getCaddyLiveConfigHash('a1')).toBe(HASH);
  });

  it('is null when Caddy refuses', async () => {
    answer(() => ({ status: 500, text: 'down', headers: {} }));
    expect(await getCaddyLiveConfigHash('a1')).toBeNull();
  });
});
