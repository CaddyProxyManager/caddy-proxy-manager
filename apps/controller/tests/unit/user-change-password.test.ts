/**
 * POST /api/user/change-password. Must end every other session, forward-auth included, and a first
 * password on a provider account is a new way in, so it needs a fresh sign-in.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '../helpers/next-intl';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  userId: 0,
  session: null as { id: number; createdAt: Date } | null,
}));

const { createTestDb } = await import('../helpers/db');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('@/src/lib/models/audit', () => ({ createAuditEvent: vi.fn() }));
vi.mock('next-intl/server', () => nextIntlServerMock());

// Only the session and its age vary; the freshness rule stays real.
const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  auth: async () => ({ user: { id: String(ctx.userId), email: 'u@example.com', role: 'user' } }),
  getCurrentSessionInfo: async () => ctx.session,
}));

import type { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { POST } from '@/src/app/api/user/change-password/route';
import { createUser, getPasswordSignInUsername, getUserById } from '../../src/lib/models/user';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import {
  accounts,
  forwardAuthSessions,
  proxyHosts,
  sessions,
  users,
} from '../../src/lib/db/schema';

const PASSWORD = 'CorrectHorse2026!';
const NEW_PASSWORD = 'BatteryStaple2027?';
const MINUTE = 60 * 1000;

let seq = 0;

async function seedUser(passwordHash: string | null) {
  seq += 1;
  const email = `change-${seq}@example.com`;
  const user = await createUser({
    email,
    provider: passwordHash ? 'credential' : 'authentik',
    subject: email,
    passwordHash,
  });
  ctx.userId = user.id;
  return user;
}

async function seedSession(userId: number, label: string): Promise<number> {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(sessions)
    .values({
      userId,
      token: `${label}-${seq}`,
      expiresAt: new Date(Date.now() + 24 * 60 * MINUTE).toISOString(),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: sessions.id });
  return row.id;
}

async function seedForwardAuthSession(userId: number) {
  const now = new Date().toISOString();
  const [host] = await ctx.db
    .insert(proxyHosts)
    .values({
      name: `app-${seq}`,
      domains: JSON.stringify([`app-${seq}.example.com`]),
      upstreams: JSON.stringify(['backend:8080']),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: proxyHosts.id });
  await ctx.db.insert(forwardAuthSessions).values({
    userId,
    proxyHostId: host.id,
    audienceOrigin: `https://app-${seq}.example.com`,
    tokenHash: `fa-${seq}`,
    expiresAt: new Date(Date.now() + 60 * MINUTE).toISOString(),
    createdAt: now,
  });
}

async function sessionIdsOf(userId: number) {
  const rows = await ctx.db.select().from(sessions).where(eq(sessions.userId, userId));
  return rows.map((row) => row.id).sort();
}

async function forwardAuthSessionsOf(userId: number) {
  return ctx.db.select().from(forwardAuthSessions).where(eq(forwardAuthSessions.userId, userId));
}

/** By hand: a real Request drops the Host header checkSameOrigin reads. */
function post(body: unknown) {
  return POST({
    method: 'POST',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'origin' ? 'http://localhost:3000' : 'localhost:3000',
    },
    json: async () => body,
  } as unknown as NextRequest);
}

beforeEach(() => {
  ctx.userId = 0;
  ctx.session = null;
});

describe('changing a password', () => {
  it('ends every other session and all forward-auth sessions, keeping the one that asked', async () => {
    const user = await seedUser(await hashPassword(PASSWORD));
    const current = await seedSession(user.id, 'current');
    await seedSession(user.id, 'other');
    await seedForwardAuthSession(user.id);
    // The current password is the re-authentication.
    ctx.session = { id: current, createdAt: new Date(Date.now() - 3 * 24 * 60 * MINUTE) };

    const response = await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(200);
    expect(await sessionIdsOf(user.id)).toEqual([current]);
    expect(await forwardAuthSessionsOf(user.id)).toHaveLength(0);
    const after = await getUserById(user.id);
    expect(await verifyPassword(NEW_PASSWORD, after!.passwordHash!)).toBe(true);
  });

  it('ends nothing when the current password is wrong', async () => {
    const user = await seedUser(await hashPassword(PASSWORD));
    const current = await seedSession(user.id, 'current');
    const other = await seedSession(user.id, 'other');
    await seedForwardAuthSession(user.id);
    ctx.session = { id: current, createdAt: new Date() };

    const response = await post({ currentPassword: 'NotThePassword1!', newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
    expect(await sessionIdsOf(user.id)).toEqual([current, other].sort());
    expect(await forwardAuthSessionsOf(user.id)).toHaveLength(1);
  });
});

describe('setting a first password on a provider-only account', () => {
  it('refuses a session that did not sign in just now, and says how to proceed', async () => {
    const user = await seedUser(null);
    const current = await seedSession(user.id, 'current');
    ctx.session = { id: current, createdAt: new Date(Date.now() - 60 * MINUTE) };

    const response = await post({ newPassword: NEW_PASSWORD });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.code).toBe('reauth-required');
    expect(data.error).toContain('sign in again');
    expect((await getUserById(user.id))?.passwordHash).toBeNull();
  });

  it('refuses a request with no session to measure', async () => {
    const user = await seedUser(null);

    const response = await post({ newPassword: NEW_PASSWORD });

    expect(response.status).toBe(403);
    expect((await getUserById(user.id))?.passwordHash).toBeNull();
  });

  it('sets it for a session that signed in moments ago', async () => {
    const user = await seedUser(null);
    const current = await seedSession(user.id, 'current');
    ctx.session = { id: current, createdAt: new Date(Date.now() - MINUTE) };

    const response = await post({ newPassword: NEW_PASSWORD });

    expect(response.status).toBe(200);
    const after = await getUserById(user.id);
    expect(await verifyPassword(NEW_PASSWORD, after!.passwordHash!)).toBe(true);
  });

  it('creates the credential account the login page checks, with the own-email username', async () => {
    const user = await seedUser(null);
    await ctx.db.update(users).set({ username: null }).where(eq(users.id, user.id));
    const current = await seedSession(user.id, 'current');
    ctx.session = { id: current, createdAt: new Date() };

    const response = await post({ newPassword: NEW_PASSWORD });

    expect(response.status).toBe(200);
    expect(await getPasswordSignInUsername(user.id)).toBe(user.email);
  });
});

describe('a self-registered account, whose hash is on the credential account only', () => {
  it('still has to prove the current password, even from a fresh session', async () => {
    const user = await seedUser(null);
    const now = new Date().toISOString();
    await ctx.db.insert(accounts).values({
      userId: user.id,
      accountId: String(user.id),
      providerId: 'credential',
      password: await hashPassword(PASSWORD),
      createdAt: now,
      updatedAt: now,
    });
    const current = await seedSession(user.id, 'current');
    ctx.session = { id: current, createdAt: new Date() };

    expect((await post({ newPassword: NEW_PASSWORD })).status).toBe(400);
    const wrong = await post({ currentPassword: 'NotThePassword1!', newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(401);
    expect((await getUserById(user.id))?.passwordHash).toBeNull();

    const right = await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(right.status).toBe(200);
    const [credential] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')));
    expect(await verifyPassword(NEW_PASSWORD, credential.password!)).toBe(true);
  });
});
