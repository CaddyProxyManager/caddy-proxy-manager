/**
 * Sign-in name rules in the user model, against a real database: the only automatic username is
 * the account's own email, no name reaches two accounts, a password set on an OAuth-only account
 * gives the login page something to sign in with, and startup only reports usernames to review.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  runInTransaction: async (build: (tx: TestDb) => unknown[]) => {
    for (const statement of build(ctx.db)) await statement;
  },
}));

import { eq } from 'drizzle-orm';
import {
  applySignInNameRules,
  createUser,
  findSignInUsernamesToReview,
  getPasswordSignInUsername,
  releaseContestedSignInUsername,
  updateUserPassword,
  updateUserProfile,
  updateUserStatus,
  warnAboutSignInUsernamesToReview,
} from '../../src/lib/models/user';
import { accounts, forwardAuthSessions, sessions, settings, users } from '../../src/lib/db/schema';

const NOW = '2026-02-01T00:00:00.000Z';

async function seedUser(email: string, username: string | null) {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      username,
      displayUsername: username,
      role: 'user',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  return row.id;
}

async function usernameOf(userId: number) {
  const [row] = await ctx.db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId));
  return row?.username;
}

beforeEach(async () => {
  await ctx.db.delete(sessions);
  await ctx.db.delete(accounts);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
});

describe('createUser', () => {
  it('gives the account its own email as username, lowercased, when it qualifies', async () => {
    const user = await createUser({ email: 'Dave@Example.com', provider: 'oidc', subject: 's' });
    expect(user.username).toBe('dave@example.com');
    expect(user.email).toBe('dave@example.com');
  });

  it('gives none when the email is not a usable username or someone else holds it', async () => {
    // The portal reads "taken@example.com" as this account's email.
    await seedUser('taken@example.com@localhost', null);
    const plus = await createUser({ email: 'carol+x@example.com', provider: 'oidc', subject: 'a' });
    const taken = await createUser({ email: 'Taken@example.com', provider: 'oidc', subject: 'b' });
    expect(plus.username).toBeNull();
    expect(taken.username).toBeNull();
  });

  it("refuses an email that is another account's username or portal name", async () => {
    await seedUser('anna@example.com', 'boss@example.com');
    await seedUser('erin@example.com', 'ops');
    await expect(
      createUser({ email: 'Boss@Example.com', provider: 'oidc', subject: 'x' }),
    ).rejects.toMatchObject({ code: 'emailIsAnotherUsername', status: 400 });
    await expect(
      createUser({ email: 'ops@localhost', provider: 'oidc', subject: 'y' }),
    ).rejects.toMatchObject({ code: 'emailPortalNameIsAnotherUsername', status: 400 });
    await expect(
      createUser({ email: ' ANNA@example.com ', provider: 'oidc', subject: 'z' }),
    ).rejects.toMatchObject({ code: 'emailTaken', status: 400 });
  });
});

describe('updateUserProfile', () => {
  it('leaves the username alone when the email changes', async () => {
    const userId = await seedUser('alice@example.com', 'alice@example.com');
    const updated = await updateUserProfile(userId, { email: 'Alice2@Example.com ' });
    expect(updated?.email).toBe('alice2@example.com');
    expect(updated?.username).toBe('alice@example.com');
  });

  it('refuses an email another account signs in with', async () => {
    await seedUser('anna@example.com', 'boss@example.com');
    const userId = await seedUser('ben@example.com', 'ben');
    await expect(updateUserProfile(userId, { email: 'boss@example.com' })).rejects.toMatchObject({
      code: 'emailIsAnotherUsername',
    });
  });
});

describe('updateUserStatus', () => {
  it('ends the Better Auth and forward-auth sessions of a disabled account', async () => {
    const userId = await seedUser('dora@example.com', 'dora@example.com');
    await seedUser('keep@example.com', 'keep');
    const now = new Date().toISOString();
    await ctx.db.insert(sessions).values({
      userId,
      token: 'dora-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    });

    await updateUserStatus(userId, 'disabled');

    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);
    expect(
      await ctx.db.select().from(forwardAuthSessions).where(eq(forwardAuthSessions.userId, userId)),
    ).toEqual([]);
  });
});

describe('updateUserPassword', () => {
  it('creates the credential account and the own-email username for an OAuth-only account', async () => {
    const userId = await seedUser('oauth@example.com', null);
    expect(await getPasswordSignInUsername(userId)).toBeNull();

    await updateUserPassword(userId, 'new-hash');

    expect(await getPasswordSignInUsername(userId)).toBe('oauth@example.com');
    const credentials = await ctx.db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ providerId: 'credential', password: 'new-hash' });

    // A second change updates the same account rather than adding one.
    await updateUserPassword(userId, 'newer-hash');
    const again = await ctx.db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(again).toHaveLength(1);
    expect(again[0].password).toBe('newer-hash');
  });

  it('keeps a usable username and gives none that another account holds', async () => {
    const kept = await seedUser('kept@example.com', 'kept');
    await updateUserPassword(kept, 'hash');
    expect(await usernameOf(kept)).toBe('kept');

    await seedUser('holder@example.com', 'shared@example.com');
    const shared = await seedUser('shared@example.com', null);
    await updateUserPassword(shared, 'hash');
    expect(await usernameOf(shared)).toBeNull();
    expect(await getPasswordSignInUsername(shared)).toBeNull();
  });
});

describe('applySignInNameRules', () => {
  it('stores no username for an OAuth sign-up, whatever the profile carried', async () => {
    const named = await applySignInNameRules(
      { email: 'idp-user@example.com', username: 'owner@example.com' },
      false,
    );
    expect(named.username).toBeNull();
  });

  it('refuses an identity provider "email" that would claim a name nobody holds yet', async () => {
    for (const email of ['root', 'newbie@localhost', 'Newbie@LOCALHOST', '@example.com', 'x@']) {
      await expect(applySignInNameRules({ email }, false)).rejects.toMatchObject({
        code: 'emailNotAllowed',
      });
    }
  });
});

describe('releaseContestedSignInUsername', () => {
  it('takes a username given to another account in between back from the new one only', async () => {
    const created = await seedUser('race@example.com', 'race@example.com');
    const other = await seedUser('other-race@example.com', 'race@example.com');

    await releaseContestedSignInUsername(created);

    expect(await usernameOf(created)).toBeNull();
    expect(await usernameOf(other)).toBe('race@example.com');

    const alone = await seedUser('alone@example.com', 'alone@example.com');
    await releaseContestedSignInUsername(alone);
    expect(await usernameOf(alone)).toBe('alone@example.com');
  });
});

describe('usernames to review at startup', () => {
  it('reports shared names and other addresses, changing nothing', async () => {
    const derived = await seedUser('alice+cpm@example.com', 'alice-cpm@example.com');
    const shared = await seedUser('anna@example.com', 'bob@example.com');
    await seedUser('bob@example.com', null);
    const portal = await seedUser('erin@example.com', 'ops');
    await seedUser('ops@localhost', 'ops@localhost');
    await seedUser('carol@example.com', 'carol@example.com');
    await seedUser('dave@example.com', 'dave');
    await seedUser('Fay@Example.com', 'fay@example.com');
    // Its own portal name is not another address.
    await seedUser('admin@example.com@localhost', 'admin@example.com');
    const before = await ctx.db.select().from(users).orderBy(users.id);

    expect(await findSignInUsernamesToReview()).toEqual([
      { userId: derived, username: 'alice-cpm@example.com', reason: 'other-address' },
      { userId: shared, username: 'bob@example.com', reason: 'shared' },
      { userId: portal, username: 'ops', reason: 'shared' },
    ]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnAboutSignInUsernamesToReview();
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toStartWith(
        `Sign-in username "alice-cpm@example.com" of user ${derived} is an email address other`,
      );
      expect(lines[1]).toStartWith(`Sign-in username "bob@example.com" of user ${shared} is also`);
    } finally {
      warn.mockRestore();
    }
    expect(await ctx.db.select().from(users).orderBy(users.id)).toEqual(before);
  });
});
