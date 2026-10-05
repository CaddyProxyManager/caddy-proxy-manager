/** The hostname cache behind access-list IP rules, with a fake resolver: nothing reaches DNS. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
import {
  type HostnameResolver,
  MAX_STALE_MS,
  expireStaleHostnames,
  readHostnameResolutions,
  refreshAccessListDns,
} from '../../../src/lib/access-lists/dns';
import type { DnsRecord } from '../../../src/lib/dns/lookup';

const T0 = Date.parse('2026-09-28T12:00:00Z');
const MINUTE = 60_000;

/** Answers from a table, failing for names it lacks; counts calls per name. */
function fakeResolver(answers: Record<string, DnsRecord[] | Error>) {
  const calls: string[] = [];
  const resolver: HostnameResolver = async (name) => {
    calls.push(name);
    const answer = answers[name];
    if (answer === undefined) throw new Error(`queryA ENOTFOUND ${name}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { resolver, calls };
}

async function pass(
  resolver: HostnameResolver,
  now: number,
): Promise<{ applied: number; changed: boolean; resolved: number }> {
  let applied = 0;
  const result = await refreshAccessListDns({
    now,
    resolver,
    apply: async () => {
      applied += 1;
    },
  });
  return { applied, ...result };
}

async function seedRules(hostnames: string[]) {
  const now = new Date(T0).toISOString();
  const [list] = await ctx.db
    .insert(schema.accessLists)
    .values({ name: 'dyn', createdAt: now, updatedAt: now })
    .returning();
  await ctx.db.insert(schema.accessListIpRules).values(
    hostnames.map((hostname, sortOrder) => ({
      accessListId: list.id,
      action: 'allow',
      hostname,
      sortOrder,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

const entry = async (name: string) => (await readHostnameResolutions([name])).get(name);

beforeEach(async () => {
  await ctx.db.delete(schema.accessListIpRules);
  await ctx.db.delete(schema.accessLists);
  await ctx.db.delete(schema.accessListDnsCache);
});

describe('refreshAccessListDns', () => {
  it('stores both families, sorted, and clamps the TTL to 60 s-1 h', async () => {
    await seedRules(['home.example.com', 'slow.example.com/56']);
    const { resolver } = fakeResolver({
      'home.example.com': [
        { address: '2001:db8::1', ttl: 5 },
        { address: '203.0.113.7', ttl: 30 },
      ],
      'slow.example.com': [{ address: '198.51.100.1', ttl: 86_400 }],
    });
    const result = await pass(resolver, T0);
    expect(result).toEqual({ applied: 1, changed: true, resolved: 2 });

    const home = await entry('home.example.com');
    expect(home?.addresses).toEqual(['2001:db8::1', '203.0.113.7']);
    expect(Date.parse(home?.expiresAt ?? '')).toBe(T0 + MINUTE);
    const slow = await entry('slow.example.com');
    expect(Date.parse(slow?.expiresAt ?? '')).toBe(T0 + 60 * MINUTE);
  });

  it('looks up only what expired, and applies only when an answer changed', async () => {
    await seedRules(['home.example.com']);
    const answers: Record<string, DnsRecord[]> = {
      'home.example.com': [
        { address: '203.0.113.7', ttl: 300 },
        { address: '203.0.113.8', ttl: 300 },
      ],
    };
    const { resolver, calls } = fakeResolver(answers);
    await pass(resolver, T0);

    expect(await pass(resolver, T0 + MINUTE)).toMatchObject({ applied: 0, resolved: 0 });
    expect(calls).toHaveLength(1);

    // Round-robin reordering is the same set.
    answers['home.example.com'].reverse();
    expect(await pass(resolver, T0 + 5 * MINUTE)).toMatchObject({ applied: 0, resolved: 1 });

    answers['home.example.com'] = [{ address: '203.0.113.9', ttl: 300 }];
    expect(await pass(resolver, T0 + 10 * MINUTE)).toMatchObject({ applied: 1, changed: true });
    expect((await entry('home.example.com'))?.addresses).toEqual(['203.0.113.9']);
  });

  it('keeps the last known answer through failures, for at most 24 h', async () => {
    await seedRules(['home.example.com']);
    const answers: Record<string, DnsRecord[] | Error> = {
      'home.example.com': [{ address: '203.0.113.7', ttl: 60 }],
    };
    const { resolver } = fakeResolver(answers);
    await pass(resolver, T0);

    answers['home.example.com'] = new Error('queryA ETIMEOUT home.example.com');
    expect(await pass(resolver, T0 + 2 * MINUTE)).toMatchObject({ applied: 0, resolved: 1 });
    const failing = await entry('home.example.com');
    expect(failing?.addresses).toEqual(['203.0.113.7']);
    expect(failing?.lastError).toContain('ETIMEOUT');
    expect(failing?.resolvedAt).toBe(new Date(T0).toISOString());
    // Retried a minute later rather than after the TTL.
    expect(Date.parse(failing?.expiresAt ?? '')).toBe(T0 + 3 * MINUTE);

    expect(await pass(resolver, T0 + MAX_STALE_MS + MINUTE)).toMatchObject({
      applied: 1,
      changed: true,
    });
    expect((await entry('home.example.com'))?.addresses).toEqual([]);

    answers['home.example.com'] = [{ address: '203.0.113.7', ttl: 60 }];
    expect(await pass(resolver, T0 + MAX_STALE_MS + 3 * MINUTE)).toMatchObject({ applied: 1 });
    expect((await entry('home.example.com'))?.lastError).toBeNull();
  });

  it('records a name that never resolved, without applying', async () => {
    await seedRules(['typo.example.com']);
    const { resolver } = fakeResolver({});
    expect(await pass(resolver, T0)).toMatchObject({ applied: 0, changed: false });
    const typo = await entry('typo.example.com');
    expect(typo?.addresses).toEqual([]);
    expect(typo?.lastError).toContain('ENOTFOUND');
  });

  it('forgets names no rule uses any more', async () => {
    await seedRules(['home.example.com']);
    const { resolver } = fakeResolver({
      'home.example.com': [{ address: '203.0.113.7', ttl: 60 }],
    });
    await pass(resolver, T0);
    await ctx.db.delete(schema.accessListIpRules);
    await pass(resolver, T0 + 5 * MINUTE);
    expect(await entry('home.example.com')).toBeUndefined();
  });
});

describe('expireStaleHostnames', () => {
  it('empties answers older than 24 h, so a long outage does not start on a stale allow', async () => {
    await ctx.db.insert(schema.accessListDnsCache).values([
      {
        hostname: 'old.example.com',
        addresses: '["203.0.113.7"]',
        resolvedAt: new Date(T0 - MAX_STALE_MS - MINUTE).toISOString(),
        expiresAt: new Date(T0).toISOString(),
      },
      {
        hostname: 'new.example.com',
        addresses: '["203.0.113.8"]',
        resolvedAt: new Date(T0 - MINUTE).toISOString(),
        expiresAt: new Date(T0).toISOString(),
      },
    ]);
    expect(await expireStaleHostnames(T0)).toBe(true);
    expect((await entry('old.example.com'))?.addresses).toEqual([]);
    expect((await entry('new.example.com'))?.addresses).toEqual(['203.0.113.8']);
    expect(await expireStaleHostnames(T0)).toBe(false);
  });
});
