/**
 * Auto-disable after repeated failed sign-ins: which user a typed name reaches, the threshold, the
 * last administrator kept, and re-enabling starting the count over.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const schemaModule = await import('@/src/lib/db/schema');
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

const { logAuditEvent } = await import('@/src/lib/audit');
const { disabledByFailedSignIns, findUserByAccountKey, recordAccountFailure } = await import(
  '@/src/lib/account-failures'
);
const { accountFailureCount, accountKey, DEFAULT_ACCOUNT_LOCK, resetAccountFailures } =
  await import('@/src/lib/rate-limit');
const { updateUserStatus } = await import('@/src/lib/models/user');
const { auditEvents, users, settings, sessions } = schemaModule;

const POLICY = { ...DEFAULT_ACCOUNT_LOCK, disableAfter: 4 };
const NOW = new Date().toISOString();

async function user(
  email: string,
  options: { role?: string; username?: string | null } = {},
): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      name: email,
      username: options.username ?? null,
      role: options.role ?? 'user',
      provider: 'credentials',
      subject: email,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();
  return row.id;
}

async function statusOf(id: number): Promise<string> {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
  return row.status;
}

async function fail(name: string, times: number, source: 'local' | 'directory' = 'local') {
  let last = null as Awaited<ReturnType<typeof recordAccountFailure>> | null;
  for (let i = 0; i < times; i++) {
    last = await recordAccountFailure(accountKey(name), source, Date.now(), POLICY);
  }
  return last!;
}

beforeEach(async () => {
  vi.mocked(logAuditEvent).mockClear();
  await ctx.db.delete(sessions);
  await ctx.db.delete(auditEvents);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
  for (const name of ['alice', 'alice@example.com', 'root', 'root@example.com', 'bob', 'dora']) {
    resetAccountFailures(accountKey(name));
  }
});

describe('findUserByAccountKey', () => {
  it('reaches an account by its email, its username, or the portal name', async () => {
    const alice = await user('alice@example.com', { username: 'alice' });
    const portal = await user('carl@localhost');

    expect((await findUserByAccountKey(accountKey('Alice@Example.com')))?.id).toBe(alice);
    expect((await findUserByAccountKey(accountKey('ALICE')))?.id).toBe(alice);
    expect((await findUserByAccountKey(accountKey('carl')))?.id).toBe(portal);
    expect(await findUserByAccountKey(accountKey('nobody'))).toBeNull();
  });
});

describe('recordAccountFailure', () => {
  it('disables the account at the threshold, and audits it once', async () => {
    const alice = await user('alice@example.com', { username: 'alice' });
    await user('root@example.com', { role: 'admin' });
    await ctx.db.insert(sessions).values({
      userId: alice,
      token: 'alice-session',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect((await fail('alice', 3)).disabled).toBeNull();
    expect(await statusOf(alice)).toBe('active');

    const outcome = await fail('alice', 1);
    expect(outcome.failures).toBe(4);
    expect(outcome.disabled?.id).toBe(alice);
    expect(await statusOf(alice)).toBe('disabled');
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, alice))).toHaveLength(0);

    // Past it, a disabled account is not disabled again.
    expect((await fail('alice', 2)).disabled).toBeNull();
    const audits = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
    expect(audits).toEqual([
      expect.objectContaining({
        userId: null,
        action: 'user_disabled_failed_sign_ins',
        entityId: alice,
        summary: 'Disabled user alice@example.com after 4 failed sign-ins',
      }),
    ]);
  });

  it('counts failures by email and username towards the same account', async () => {
    const alice = await user('alice@example.com', { username: 'alice@example.com' });
    await user('root@example.com', { role: 'admin' });
    await fail('alice@example.com', 4);
    expect(await statusOf(alice)).toBe('disabled');
  });

  it('keeps the last active administrator, on the timed lock only', async () => {
    const root = await user('root@example.com', { role: 'admin', username: 'root' });

    const outcome = await fail('root', 4);
    expect(outcome.disabled).toBeNull();
    expect(outcome.keptLastAdmin?.id).toBe(root);
    expect(outcome.delayMs).toBe(0);
    expect(await statusOf(root)).toBe('active');
    // Said once per streak, not on every further failure.
    expect((await fail('root', 1)).keptLastAdmin).toBeNull();
  });

  it('disables an administrator who is not the last one', async () => {
    const root = await user('root@example.com', { role: 'admin', username: 'root' });
    await user('other@example.com', { role: 'admin' });
    expect((await fail('root', 4)).disabled?.id).toBe(root);
    expect(await statusOf(root)).toBe('disabled');
  });

  it('never disables on a directory failure, which names no CPM user', async () => {
    const bob = await user('bob@localhost', { username: 'bob' });
    await user('root@example.com', { role: 'admin' });
    await fail('bob', 6, 'directory');
    expect(await statusOf(bob)).toBe('active');
    // The count is shared, so the next local failure past the threshold does.
    await fail('bob', 1);
    expect(await statusOf(bob)).toBe('disabled');
  });

  it('does nothing while auto-disable is off', async () => {
    const dora = await user('dora@example.com', { username: 'dora' });
    for (let i = 0; i < 12; i++) {
      await recordAccountFailure(accountKey('dora'), 'local', Date.now(), DEFAULT_ACCOUNT_LOCK);
    }
    expect(await statusOf(dora)).toBe('active');
  });

  it('names an administrator the lock engaged on, once', async () => {
    const root = await user('root@example.com', { role: 'admin', username: 'root' });
    const engaged = [];
    for (let i = 0; i < 8; i++) {
      const outcome = await recordAccountFailure(
        accountKey('root'),
        'local',
        Date.now(),
        DEFAULT_ACCOUNT_LOCK,
      );
      if (outcome.lockedAdmin) engaged.push(outcome.lockedAdmin.id);
    }
    expect(engaged).toEqual([root]);
  });
});

describe('re-enabling', () => {
  it('starts the count over, so the next typo does not disable it again', async () => {
    const alice = await user('alice@example.com', { username: 'alice' });
    await user('root@example.com', { role: 'admin' });
    await fail('alice', 4);
    expect(await statusOf(alice)).toBe('disabled');

    await updateUserStatus(alice, 'active');
    expect(accountFailureCount(accountKey('alice'))).toBe(0);
    await fail('alice', 1);
    expect(await statusOf(alice)).toBe('active');
  });
});

describe('disabledByFailedSignIns', () => {
  it('reads whether the latest status change was the auto-disable', async () => {
    const auto = await user('auto@example.com');
    const manual = await user('manual@example.com');
    const reenabledThenDisabled = await user('again@example.com');
    const row = (entityId: number, action: string, summary: string) => ({
      userId: null,
      action,
      entityType: 'user',
      entityId,
      summary,
      createdAt: NOW,
    });
    await ctx.db
      .insert(auditEvents)
      .values([
        row(auto, 'user_disabled_failed_sign_ins', 'Disabled user a after 4 failed sign-ins'),
        row(manual, 'update', `Changed user ${manual} status to disabled`),
        row(reenabledThenDisabled, 'user_disabled_failed_sign_ins', 'Disabled user b after 4'),
      ]);
    await ctx.db
      .insert(auditEvents)
      .values(
        row(
          reenabledThenDisabled,
          'update',
          `Changed user ${reenabledThenDisabled} status to disabled`,
        ),
      );

    expect(await disabledByFailedSignIns([auto, manual, reenabledThenDisabled])).toEqual(
      new Set([auto]),
    );
    expect(await disabledByFailedSignIns([])).toEqual(new Set());
  });
});
