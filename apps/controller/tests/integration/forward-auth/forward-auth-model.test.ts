/**
 * The forward-auth model's bookkeeping against a real database: who may reach a host, the session
 * list an admin revokes from, and the paths that must fail closed when a credential no longer
 * matches the host it was minted for. forward-auth-audience.test.ts covers the happy flow.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import {
  checkHostAccess,
  consumeRedirectIntent,
  createExchangeCode,
  createForwardAuthSession,
  createRedirectIntent,
  deleteForwardAuthSession,
  type ForwardAuthAudience,
  getForwardAuthAccessForHost,
  isForwardAuthDomain,
  listForwardAuthSessions,
  parseForwardAuthPortList,
  redeemExchangeCode,
  resolveForwardAuthAudience,
  setForwardAuthAccess,
} from '@/src/lib/models/forward-auth';
import { logAuditEvent } from '@/src/lib/audit';
import { DomainError } from '@/src/lib/errors/domain-error';
import { invalidateSettingsCache } from '@/src/lib/settings/resolve';
import { announce } from '@/src/lib/cluster/announcements';
import {
  forwardAuthAccess,
  forwardAuthExchanges,
  forwardAuthRedirectIntents,
  forwardAuthSessions,
  groupMembers,
  groups,
  proxyHosts,
  users,
} from '../../../src/lib/db/schema';

const NOW = '2026-03-01T00:00:00.000Z';

function allowPorts(value: string | undefined) {
  if (value === undefined) delete process.env.FORWARD_AUTH_ALLOWED_PORTS;
  else process.env.FORWARD_AUTH_ALLOWED_PORTS = value;
  invalidateSettingsCache();
}

async function seedUser(email: string): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({ email, createdAt: NOW, updatedAt: NOW })
    .returning({ id: users.id });
  return row.id;
}

async function seedHost(
  domains: string[],
  meta: string | null = JSON.stringify({ cpm_forward_auth: { enabled: true } }),
  rawDomains?: string,
): Promise<number> {
  const [row] = await ctx.db
    .insert(proxyHosts)
    .values({
      name: domains[0] ?? 'broken',
      domains: rawDomains ?? JSON.stringify(domains),
      upstreams: JSON.stringify(['backend:8080']),
      meta,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: proxyHosts.id });
  return row.id;
}

function audienceFor(proxyHostId: number, origin = 'https://app.example.com'): ForwardAuthAudience {
  return { origin, hostname: new URL(origin).hostname, proxyHostId };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
}

beforeEach(async () => {
  allowPorts(undefined);
  vi.mocked(logAuditEvent).mockClear();
  for (const table of [
    forwardAuthExchanges,
    forwardAuthSessions,
    forwardAuthRedirectIntents,
    forwardAuthAccess,
    groupMembers,
    groups,
    proxyHosts,
    users,
  ]) {
    await ctx.db.delete(table);
  }
});

afterAll(() => allowPorts(undefined));

describe('parseForwardAuthPortList', () => {
  it('keeps real ports, trimmed, and drops everything else', () => {
    // A leading zero is dropped rather than read as another port.
    expect([...parseForwardAuthPortList(' 8443, 08080 ,0, 65536, abc, 443,,9443x')]).toEqual([
      '8443',
      '443',
    ]);
  });
});

describe('host access', () => {
  it('grants a user directly or through a group, and nobody else', async () => {
    const host = await seedHost(['app.example.com']);
    const direct = await seedUser('direct@example.com');
    const member = await seedUser('member@example.com');
    const outsider = await seedUser('outsider@example.com');
    const [group] = await ctx.db
      .insert(groups)
      .values({ name: 'ops', createdAt: NOW, updatedAt: NOW })
      .returning();
    await ctx.db.insert(groupMembers).values({ groupId: group.id, userId: member, createdAt: NOW });

    const entries = await setForwardAuthAccess(
      host,
      { userIds: [direct], groupIds: [group.id] },
      direct,
    );

    expect(entries.map((entry) => [entry.userId, entry.groupId])).toEqual(
      expect.arrayContaining([
        [direct, null],
        [null, group.id],
      ]),
    );
    expect(await checkHostAccess(direct, host)).toBe(true);
    expect(await checkHostAccess(member, host)).toBe(true);
    expect(await checkHostAccess(outsider, host)).toBe(false);
    expect(await checkHostAccess(99999, host)).toBe(false);
    expect(vi.mocked(logAuditEvent).mock.calls[0][0]).toMatchObject({
      action: 'update',
      entityType: 'forward_auth_access',
      entityId: host,
    });
  });

  it('replaces the whole list, so an empty one revokes everyone', async () => {
    const host = await seedHost(['app.example.com']);
    const other = await seedHost(['other.example.com']);
    const alice = await seedUser('alice@example.com');
    await setForwardAuthAccess(host, { userIds: [alice] }, alice);
    await setForwardAuthAccess(other, { userIds: [alice] }, alice);

    expect(await setForwardAuthAccess(host, {}, alice)).toEqual([]);

    expect(await checkHostAccess(alice, host)).toBe(false);
    // Another host's list is its own.
    expect(await getForwardAuthAccessForHost(other)).toHaveLength(1);
  });
});

describe('sessions', () => {
  it('lists live sessions only, and deletes one by id', async () => {
    const host = await seedHost(['app.example.com']);
    const alice = await seedUser('alice@example.com');
    const { session: live } = await createForwardAuthSession(alice, audienceFor(host));
    const { session: other } = await createForwardAuthSession(alice, audienceFor(host));
    await ctx.db.insert(forwardAuthSessions).values({
      userId: alice,
      proxyHostId: host,
      audienceOrigin: 'https://app.example.com',
      tokenHash: 'expired',
      expiresAt: '2000-01-01T00:00:00.000Z',
      createdAt: NOW,
    });

    const listed = await listForwardAuthSessions();
    expect(listed.map((session) => session.id).sort()).toEqual([live.id, other.id].sort());
    expect(listed[0]).toMatchObject({ userId: alice, proxyHostId: host });

    await deleteForwardAuthSession(live.id);
    expect((await listForwardAuthSessions()).map((session) => session.id)).toEqual([other.id]);
  });

  it('refuses an audience that is not the origin it names', async () => {
    const host = await seedHost(['app.example.com']);
    const alice = await seedUser('alice@example.com');
    for (const audience of [
      { origin: 'https://app.example.com', hostname: 'evil.example.com', proxyHostId: host },
      { origin: 'https://app.example.com', hostname: 'app.example.com', proxyHostId: 0 },
      { origin: 'ftp://app.example.com', hostname: 'app.example.com', proxyHostId: host },
      // A non-default port nobody declared.
      audienceFor(host, 'https://app.example.com:8443'),
    ]) {
      expect(await codeOf(createForwardAuthSession(alice, audience))).toBe(
        'invalidForwardAuthAudience',
      );
    }
    expect(await ctx.db.select().from(forwardAuthSessions)).toEqual([]);
  });
});

describe('exchange codes', () => {
  it("refuses a redirect outside the session's audience", async () => {
    const host = await seedHost(['app.example.com']);
    const alice = await seedUser('alice@example.com');
    const { session } = await createForwardAuthSession(alice, audienceFor(host));

    expect(
      await codeOf(createExchangeCode(session.id, 'https://evil.example.com/', audienceFor(host))),
    ).toBe('invalidForwardAuthAudience');
  });

  it('refuses a session minted for another host, or none at all', async () => {
    const host = await seedHost(['app.example.com']);
    const other = await seedHost(['other.example.com']);
    const alice = await seedUser('alice@example.com');
    const { session } = await createForwardAuthSession(alice, audienceFor(host));
    const otherAudience = audienceFor(other, 'https://other.example.com');

    expect(
      await codeOf(createExchangeCode(session.id, 'https://other.example.com/', otherAudience)),
    ).toBe('forwardAuthSessionAudienceMismatch');
    expect(
      await codeOf(createExchangeCode(99999, 'https://app.example.com/', audienceFor(host))),
    ).toBe('forwardAuthSessionAudienceMismatch');
    expect(await ctx.db.select().from(forwardAuthExchanges)).toEqual([]);
  });

  it('burns a code whose port was withdrawn before it was redeemed', async () => {
    allowPorts('8443');
    const origin = 'https://app.example.com:8443';
    const host = await seedHost(['app.example.com']);
    const alice = await seedUser('alice@example.com');
    const audience = audienceFor(host, origin);
    const { session } = await createForwardAuthSession(alice, audience);
    const { rawCode } = await createExchangeCode(session.id, `${origin}/path`, audience);

    allowPorts(undefined);

    expect(await redeemExchangeCode(rawCode, audience)).toBeNull();
    expect(await ctx.db.select().from(forwardAuthExchanges)).toEqual([]);
    allowPorts('8443');
    expect(await redeemExchangeCode(rawCode, audience)).toBeNull();
  });
});

describe('redirect intents', () => {
  it('fails closed when the host stopped protecting the target after the intent was made', async () => {
    const host = await seedHost(['app.example.com']);
    const rid = await createRedirectIntent('https://app.example.com/dashboard');

    await ctx.db
      .update(proxyHosts)
      .set({ meta: JSON.stringify({ cpm_forward_auth: { enabled: false } }) })
      .where(eq(proxyHosts.id, host));
    // What the apply after a host write announces.
    announce('proxy-hosts');

    expect(await consumeRedirectIntent(rid)).toBeNull();
    // Consumed regardless: a retry cannot succeed later either.
    expect(await ctx.db.select().from(forwardAuthRedirectIntents)).toEqual([]);
  });

  it('refuses a target with credentials in it', async () => {
    await seedHost(['app.example.com']);
    expect(await codeOf(createRedirectIntent('https://user:pass@app.example.com/'))).toBe(
      'invalidForwardAuthRedirectTarget',
    );
  });
});

describe('which hosts are protected', () => {
  it('lets an exact host decide alone, never falling back to a wildcard', async () => {
    await seedHost(['*.example.com']);
    await seedHost(['plain.example.com'], null);

    expect(await isForwardAuthDomain('app.example.com')).toBe(true);
    // Exact, unprotected: the protected wildcard does not reach it, as Caddy routes it.
    expect(await isForwardAuthDomain('plain.example.com')).toBe(false);
    expect(await isForwardAuthDomain('example.org')).toBe(false);
  });

  it('skips a host whose stored domains or meta do not parse', async () => {
    await seedHost([], JSON.stringify({ cpm_forward_auth: { enabled: true } }), 'not json');
    await seedHost(['broken-meta.example.com'], '{not json');
    const good = await seedHost(['good.example.com']);

    expect(await isForwardAuthDomain('broken-meta.example.com')).toBe(false);
    expect((await resolveForwardAuthAudience('https://good.example.com/x'))?.proxyHostId).toBe(
      good,
    );
  });

  it('does not protect through a disabled wildcard', async () => {
    await seedHost(['*.example.com'], JSON.stringify({ cpm_forward_auth: { enabled: false } }));
    expect(await isForwardAuthDomain('app.example.com')).toBe(false);
  });
});
