/**
 * What a back-channel logout does to the database, and how a session learns its IdP session.
 * Token verification is tests/unit/oidc-logout-token.test.ts; here the token is already genuine.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    sqlite: undefined,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (value: string | Date | null | undefined): string | null =>
      !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  };
});

import { eq } from 'drizzle-orm';
import {
  accounts,
  forwardAuthSessions,
  proxyHosts,
  sessions,
  users,
} from '../../src/lib/db/schema';
import {
  bindSessionToIdpSession,
  clearPendingSessionBindings,
  consumePendingSessionBinding,
  recordSessionBindingFromIdToken,
  revokeSessionsForLogoutToken,
} from '../../src/lib/services/oidc-logout';

const now = '2026-01-01T00:00:00.000Z';
const PROVIDER = 'authentik';

function idTokenWith(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url').replace(/=+$/, '');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
}

async function createUser(email: string): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({ email, name: email, role: 'user', status: 'active', createdAt: now, updatedAt: now })
    .returning();
  return row.id;
}

async function linkAccount(userId: number, subject: string, providerId = PROVIDER): Promise<void> {
  await ctx.db.insert(accounts).values({
    userId,
    accountId: subject,
    providerId,
    createdAt: now,
    updatedAt: now,
  });
}

let tokenCounter = 0;

async function createSession(
  userId: number,
  binding?: { providerId: string; sid: string },
): Promise<number> {
  tokenCounter += 1;
  const [row] = await ctx.db
    .insert(sessions)
    .values({
      userId,
      token: `token-${tokenCounter}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      oidcProviderId: binding?.providerId ?? null,
      oidcSid: binding?.sid ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row.id;
}

async function createProxyHost(): Promise<number> {
  const [row] = await ctx.db
    .insert(proxyHosts)
    .values({
      name: 'app',
      domains: 'app.example',
      upstreams: 'http://127.0.0.1:8080',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row.id;
}

async function createForwardAuthSession(userId: number, proxyHostId: number): Promise<void> {
  tokenCounter += 1;
  await ctx.db.insert(forwardAuthSessions).values({
    userId,
    proxyHostId,
    audienceOrigin: 'https://app.example',
    tokenHash: `hash-${tokenCounter}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: now,
  });
}

async function sessionIdsFor(userId: number): Promise<number[]> {
  const rows = await ctx.db.select().from(sessions).where(eq(sessions.userId, userId));
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

beforeEach(async () => {
  clearPendingSessionBindings();
  await ctx.db.delete(forwardAuthSessions);
  await ctx.db.delete(sessions);
  await ctx.db.delete(accounts);
  await ctx.db.delete(proxyHosts);
  await ctx.db.delete(users);
});

describe('binding a CPM session to the IdP session it came from', () => {
  it('parks the sid an ID token carries and stamps it on the session', async () => {
    const userId = await createUser('sso@example.com');
    const sessionId = await createSession(userId);

    recordSessionBindingFromIdToken(userId, PROVIDER, idTokenWith({ sub: 'u-1', sid: 'idp-1' }));
    await bindSessionToIdpSession(userId, sessionId);

    const [row] = await ctx.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row.oidcProviderId).toBe(PROVIDER);
    expect(row.oidcSid).toBe('idp-1');
  });

  it('parks nothing for a provider that issues no sid', async () => {
    recordSessionBindingFromIdToken(1, PROVIDER, idTokenWith({ sub: 'u-1' }));

    expect(consumePendingSessionBinding(1)).toBeNull();
  });

  it('parks nothing when there is no ID token at all', async () => {
    recordSessionBindingFromIdToken(1, PROVIDER, null);

    expect(consumePendingSessionBinding(1)).toBeNull();
  });

  it('hands a parked binding back exactly once', () => {
    recordSessionBindingFromIdToken(1, PROVIDER, idTokenWith({ sid: 'idp-1' }));

    expect(consumePendingSessionBinding(1)?.sid).toBe('idp-1');
    expect(consumePendingSessionBinding(1)).toBeNull();
  });

  it('leaves a session unbound when nothing was parked for that user', async () => {
    const userId = await createUser('local@example.com');
    const sessionId = await createSession(userId);

    recordSessionBindingFromIdToken(userId + 1, PROVIDER, idTokenWith({ sid: 'idp-1' }));
    await bindSessionToIdpSession(userId, sessionId);

    const [row] = await ctx.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row.oidcSid).toBeNull();
  });
});

describe('revoking what a logout token names', () => {
  it('ends only the named IdP session, leaving the user other devices', async () => {
    const userId = await createUser('sso@example.com');
    await linkAccount(userId, 'u-1');
    const phone = await createSession(userId, { providerId: PROVIDER, sid: 'idp-1' });
    const laptop = await createSession(userId, { providerId: PROVIDER, sid: 'idp-2' });

    const result = await revokeSessionsForLogoutToken({
      providerId: PROVIDER,
      subject: null,
      sessionId: 'idp-1',
    });

    expect(result.sessions).toBe(1);
    expect(await sessionIdsFor(userId)).toEqual([laptop]);
    expect(phone).not.toBe(laptop);
  });

  it('keeps a sid scoped even when the token names the subject too', async () => {
    // Most providers send both claims. Acting on the `sub` as well would end every session the
    // user has, which makes session-scoped logout impossible to ask for.
    const userId = await createUser('sso@example.com');
    await linkAccount(userId, 'u-1');
    await createSession(userId, { providerId: PROVIDER, sid: 'idp-1' });
    const laptop = await createSession(userId, { providerId: PROVIDER, sid: 'idp-2' });

    const result = await revokeSessionsForLogoutToken({
      providerId: PROVIDER,
      subject: 'u-1',
      sessionId: 'idp-1',
    });

    expect(result.sessions).toBe(1);
    expect(await sessionIdsFor(userId)).toEqual([laptop]);
  });

  it('still drops forward-auth sessions on a sid-scoped logout naming a subject', async () => {
    const userId = await createUser('sso@example.com');
    await linkAccount(userId, 'u-1');
    const proxyHostId = await createProxyHost();
    await createForwardAuthSession(userId, proxyHostId);
    await createSession(userId, { providerId: PROVIDER, sid: 'idp-1' });

    await revokeSessionsForLogoutToken({
      providerId: PROVIDER,
      subject: 'u-1',
      sessionId: 'idp-1',
    });

    const remaining = await ctx.db
      .select()
      .from(forwardAuthSessions)
      .where(eq(forwardAuthSessions.userId, userId));
    expect(remaining).toEqual([]);
  });

  it('ends every session for a subject when the token names no session', async () => {
    const userId = await createUser('sso@example.com');
    await linkAccount(userId, 'u-1');
    await createSession(userId, { providerId: PROVIDER, sid: 'idp-1' });
    await createSession(userId);

    const result = await revokeSessionsForLogoutToken({
      providerId: PROVIDER,
      subject: 'u-1',
      sessionId: null,
    });

    expect(result.sessions).toBe(2);
    expect(await sessionIdsFor(userId)).toEqual([]);
  });

  it('leaves other users signed in', async () => {
    const target = await createUser('sso@example.com');
    const bystander = await createUser('other@example.com');
    await linkAccount(target, 'u-1');
    await linkAccount(bystander, 'u-2');
    await createSession(target);
    const untouched = await createSession(bystander);

    await revokeSessionsForLogoutToken({ providerId: PROVIDER, subject: 'u-1', sessionId: null });

    expect(await sessionIdsFor(bystander)).toEqual([untouched]);
  });

  it('does not match a sid belonging to a different provider', async () => {
    const userId = await createUser('sso@example.com');
    const kept = await createSession(userId, { providerId: 'other-idp', sid: 'idp-1' });

    const result = await revokeSessionsForLogoutToken({
      providerId: PROVIDER,
      subject: null,
      sessionId: 'idp-1',
    });

    expect(result.sessions).toBe(0);
    expect(await sessionIdsFor(userId)).toEqual([kept]);
  });

  it('drops the forward-auth sessions that outlive the CPM one', async () => {
    const userId = await createUser('sso@example.com');
    await linkAccount(userId, 'u-1');
    const proxyHostId = await createProxyHost();
    await createForwardAuthSession(userId, proxyHostId);
    await createSession(userId, { providerId: PROVIDER, sid: 'idp-1' });

    await revokeSessionsForLogoutToken({
      providerId: PROVIDER,
      subject: null,
      sessionId: 'idp-1',
    });

    const remaining = await ctx.db
      .select()
      .from(forwardAuthSessions)
      .where(eq(forwardAuthSessions.userId, userId));
    expect(remaining).toEqual([]);
  });

  it('reports the users it signed out', async () => {
    const userId = await createUser('sso@example.com');
    await linkAccount(userId, 'u-1');
    await createSession(userId);

    const result = await revokeSessionsForLogoutToken({
      providerId: PROVIDER,
      subject: 'u-1',
      sessionId: null,
    });

    expect(result.userIds).toEqual([userId]);
  });

  it('is a no-op when the subject never signed in here', async () => {
    const result = await revokeSessionsForLogoutToken({
      providerId: PROVIDER,
      subject: 'nobody',
      sessionId: null,
    });

    expect(result).toEqual({ sessions: 0, userIds: [] });
  });
});
