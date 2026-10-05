/**
 * Applying an IdP's group claim to a CPM user: role assignment (including the
 * last-admin safeguard) and reconciliation of IdP-owned group membership.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import {
  accounts,
  groupIdpMappings,
  groupMembers,
  groups,
  users,
} from '../../../src/lib/db/schema';
import {
  applyOidcSync,
  clearPendingOidcSyncs,
  consumePendingOidcSync,
  recordPendingOidcSync,
  reconcileOidcUserAfterSignIn,
  type PendingOidcSync,
} from '../../../src/lib/services/oidc-group-sync';

const now = '2026-01-01T00:00:00.000Z';

function entry(overrides: Partial<PendingOidcSync> = {}): PendingOidcSync {
  return {
    providerId: 'authentik',
    subject: 'sub-1',
    providerName: 'Authentik',
    role: null,
    localGroups: [],
    claimedGroups: [],
    syncGroups: false,
    ...overrides,
  };
}

async function createUser(email: string, role: string, status = 'active'): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({ email, name: email, role, status, createdAt: now, updatedAt: now })
    .returning();
  return row.id;
}

async function roleOf(userId: number): Promise<string> {
  const rows = await ctx.db.select().from(users).where(eq(users.id, userId));
  return rows[0].role;
}

async function groupNamesFor(userId: number): Promise<string[]> {
  const rows = await ctx.db
    .select({ name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.userId, userId));
  return rows.map((r) => r.name).sort();
}

beforeEach(async () => {
  clearPendingOidcSyncs();
  await ctx.db.delete(groupMembers);
  await ctx.db.delete(groups);
  await ctx.db.delete(accounts);
  await ctx.db.delete(users);
});

describe('pending sync registry', () => {
  it('hands an entry back exactly once, keyed by provider and subject', () => {
    recordPendingOidcSync(entry({ role: 'admin' }));
    expect(consumePendingOidcSync('authentik', 'sub-1')?.role).toBe('admin');
    expect(consumePendingOidcSync('authentik', 'sub-1')).toBeNull();
  });

  it('does not leak an entry to a different subject on the same provider', () => {
    recordPendingOidcSync(entry({ subject: 'sub-1', role: 'admin' }));
    expect(consumePendingOidcSync('authentik', 'sub-2')).toBeNull();
  });
});

describe('role assignment', () => {
  it('promotes a user whose groups map to admin', async () => {
    const existingAdmin = await createUser('admin@example.com', 'admin');
    const userId = await createUser('dev@example.com', 'user');

    await applyOidcSync(userId, entry({ role: 'admin' }));

    expect(await roleOf(userId)).toBe('admin');
    expect(await roleOf(existingAdmin)).toBe('admin');
  });

  it('demotes a user who no longer holds the admin group', async () => {
    await createUser('admin@example.com', 'admin');
    const userId = await createUser('ex-admin@example.com', 'admin');

    await applyOidcSync(userId, entry({ role: 'user' }));

    expect(await roleOf(userId)).toBe('user');
  });

  it('keeps the last active admin an admin', async () => {
    const userId = await createUser('only-admin@example.com', 'admin');
    await createUser('someone@example.com', 'user');

    await applyOidcSync(userId, entry({ role: 'user' }));

    expect(await roleOf(userId)).toBe('admin');
  });

  it('does not count a disabled admin as a remaining admin', async () => {
    const userId = await createUser('only-active-admin@example.com', 'admin');
    await createUser('disabled-admin@example.com', 'admin', 'disabled');

    await applyOidcSync(userId, entry({ role: 'viewer' }));

    expect(await roleOf(userId)).toBe('admin');
  });

  it('leaves the role untouched when the provider does not map roles', async () => {
    const userId = await createUser('dev@example.com', 'viewer');

    await applyOidcSync(userId, entry({ role: null }));

    expect(await roleOf(userId)).toBe('viewer');
  });
});

describe('group membership', () => {
  it('creates missing groups and adds the user to them', async () => {
    const userId = await createUser('dev@example.com', 'user');

    await applyOidcSync(userId, entry({ syncGroups: true, localGroups: ['Devs', 'Ops'] }));

    expect(await groupNamesFor(userId)).toEqual(['Devs', 'Ops']);
    const created = await ctx.db.select().from(groups);
    expect(created.every((g) => g.source === 'oidc')).toBe(true);
  });

  it('removes membership of IdP groups that are no longer claimed', async () => {
    const userId = await createUser('dev@example.com', 'user');
    await applyOidcSync(userId, entry({ syncGroups: true, localGroups: ['Devs', 'Ops'] }));

    await applyOidcSync(userId, entry({ syncGroups: true, localGroups: ['Devs'] }));

    expect(await groupNamesFor(userId)).toEqual(['Devs']);
  });

  it('never removes membership of a group an operator created', async () => {
    const userId = await createUser('dev@example.com', 'user');
    const [manual] = await ctx.db
      .insert(groups)
      .values({ name: 'Manual', source: 'ui', createdAt: now, updatedAt: now })
      .returning();
    await ctx.db.insert(groupMembers).values({ groupId: manual.id, userId, createdAt: now });

    await applyOidcSync(userId, entry({ syncGroups: true, localGroups: ['Devs'] }));

    expect(await groupNamesFor(userId)).toEqual(['Devs', 'Manual']);
  });

  it('does not join an operator-created group on a bare name match', async () => {
    const userId = await createUser('dev@example.com', 'user');
    await ctx.db
      .insert(groups)
      .values({ name: 'Devs', source: 'ui', createdAt: now, updatedAt: now });

    await applyOidcSync(userId, entry({ syncGroups: true, localGroups: ['devs'] }));

    // Neither joined nor twinned: the UI group's grants were never tied to the IdP.
    const all = await ctx.db.select().from(groups);
    expect(all).toHaveLength(1);
    expect(all[0].source).toBe('ui');
    expect(await groupNamesFor(userId)).toEqual([]);
  });

  it('joins an operator-created group that an explicit mapping names', async () => {
    const userId = await createUser('dev@example.com', 'user');
    const [manual] = await ctx.db
      .insert(groups)
      .values({ name: 'Devs', source: 'ui', createdAt: now, updatedAt: now })
      .returning();
    await ctx.db.insert(groupIdpMappings).values({
      groupId: manual.id,
      providerId: null,
      externalName: 'engineering',
      externalKey: 'engineering',
      createdAt: now,
    });

    await applyOidcSync(
      userId,
      entry({ syncGroups: true, claimedGroups: ['engineering'], localGroups: [] }),
    );

    expect(await groupNamesFor(userId)).toEqual(['Devs']);
  });

  it('leaves membership alone when group sync is off', async () => {
    const userId = await createUser('dev@example.com', 'user');

    await applyOidcSync(userId, entry({ syncGroups: false, localGroups: ['Devs'] }));

    expect(await groupNamesFor(userId)).toEqual([]);
  });
});

describe('reconcileOidcUserAfterSignIn', () => {
  it('finds the pending entry through the user linked account', async () => {
    await createUser('admin@example.com', 'admin');
    const userId = await createUser('dev@example.com', 'user');
    await ctx.db.insert(accounts).values({
      userId,
      accountId: 'sub-1',
      providerId: 'authentik',
      createdAt: now,
      updatedAt: now,
    });

    recordPendingOidcSync(entry({ role: 'admin' }));
    await reconcileOidcUserAfterSignIn(userId);

    expect(await roleOf(userId)).toBe('admin');
  });

  it('ignores a pending entry that belongs to another user subject', async () => {
    await createUser('admin@example.com', 'admin');
    const userId = await createUser('dev@example.com', 'user');
    await ctx.db.insert(accounts).values({
      userId,
      accountId: 'other-sub',
      providerId: 'authentik',
      createdAt: now,
      updatedAt: now,
    });

    recordPendingOidcSync(entry({ subject: 'sub-1', role: 'admin' }));
    await reconcileOidcUserAfterSignIn(userId);

    expect(await roleOf(userId)).toBe('user');
  });

  it('is a no-op for a credential sign-in with nothing pending', async () => {
    const userId = await createUser('local@example.com', 'user');
    await expect(reconcileOidcUserAfterSignIn(userId)).resolves.toBeUndefined();
    expect(await roleOf(userId)).toBe('user');
  });
});
