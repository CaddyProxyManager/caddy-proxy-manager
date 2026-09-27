/**
 * At least one active admin must survive any mix of concurrent role, status, delete and OIDC
 * changes: two admins removing each other at once must not both succeed.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { createTestDb, currentDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const schemaModule = await import('@/src/lib/db/schema');
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => ({
  default: currentDb(() => ctx.db),
  db: currentDb(() => ctx.db),
  client: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));
vi.mock('@/src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

const { deleteUser, updateUserRole, updateUserStatus } = await import('@/src/lib/models/user');
const { applyOidcSync } = await import('@/src/lib/services/oidc-group-sync');
const { users, settings } = schemaModule;

async function admin(email: string): Promise<number> {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      name: email,
      role: 'admin',
      provider: 'credentials',
      subject: email,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row.id;
}

async function activeAdmins(): Promise<number> {
  const rows = await ctx.db.select().from(users);
  return rows.filter((row) => row.role === 'admin' && row.status === 'active').length;
}

/** Runs both at once; exactly one may succeed, and the other is refused by the invariant. */
async function race(first: () => Promise<unknown>, second: () => Promise<unknown>) {
  const results = await Promise.allSettled([first(), second()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  expect(refused.reason).toMatchObject({ code: 'lastActiveAdmin' });
  expect(await activeAdmins()).toBe(1);
}

beforeEach(async () => {
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
});

describe('the last active administrator', () => {
  it('survives two admins demoting each other', async () => {
    const [a, b] = [await admin('a@x.test'), await admin('b@x.test')];
    await race(
      () => updateUserRole(a, 'user'),
      () => updateUserRole(b, 'user'),
    );
  });

  it('survives two admins disabling each other', async () => {
    const [a, b] = [await admin('a@x.test'), await admin('b@x.test')];
    await race(
      () => updateUserStatus(a, 'disabled'),
      () => updateUserStatus(b, 'disabled'),
    );
  });

  it('survives two admins deleting each other', async () => {
    const [a, b] = [await admin('a@x.test'), await admin('b@x.test')];
    await race(
      () => deleteUser(a),
      () => deleteUser(b),
    );
  });

  it('survives a demotion racing a delete', async () => {
    const [a, b] = [await admin('a@x.test'), await admin('b@x.test')];
    await race(
      () => updateUserRole(a, 'viewer'),
      () => deleteUser(b),
    );
  });

  it('is kept by two concurrent OIDC reconciliations', async () => {
    const [a, b] = [await admin('a@x.test'), await admin('b@x.test')];
    const demote = {
      providerId: 'authentik',
      subject: 's',
      providerName: 'Authentik',
      role: 'user' as const,
      localGroups: [],
      claimedGroups: [],
      syncGroups: false,
    };
    await Promise.all([applyOidcSync(a, demote), applyOidcSync(b, demote)]);
    expect(await activeAdmins()).toBe(1);
  });

  it('still lets an admin go while another stays', async () => {
    const [a] = [await admin('a@x.test'), await admin('b@x.test')];
    await updateUserRole(a, 'user');
    const [row] = await ctx.db.select().from(users).where(eq(users.id, a));
    expect(row.role).toBe('user');
    expect(await activeAdmins()).toBe(1);
  });
});
