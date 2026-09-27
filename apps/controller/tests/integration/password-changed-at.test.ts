/**
 * users.passwordChangedAt. The env-seeded admin is re-checked on every start, and only an
 * ADMIN_PASSWORD that changed is a change - dating anything else would report one per restart.
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

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
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
  createUser,
  getUserById,
  markPasswordChanged,
  removeUserPassword,
  updateUserPassword,
  usersWithPassword,
} from '../../src/lib/models/user';
import { ensureAdminUser } from '../../src/lib/init-db';
import { hashPassword } from '../../src/lib/password';
import { accounts, settings, users } from '../../src/lib/db/schema';

const TOUCHED_ENV = ['ADMIN_USERNAME', 'ADMIN_PASSWORD'];

async function changedAt(userId: number): Promise<string | null> {
  return (await getUserById(userId))?.passwordChangedAt ?? null;
}

/** Long enough apart that two ISO timestamps cannot collide on the millisecond. */
const tick = () => Bun.sleep(5);

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  await ctx.db.delete(accounts);
  await ctx.db.delete(users);
});

describe('users.passwordChangedAt', () => {
  it('is set when a user is created with a password, and not without one', async () => {
    const local = await createUser({
      email: 'local@example.com',
      provider: 'credentials',
      subject: 'local@example.com',
      passwordHash: 'hash',
    });
    const federated = await createUser({
      email: 'sso@example.com',
      provider: 'oidc',
      subject: 'sso-subject',
    });

    expect(local.passwordChangedAt).not.toBeNull();
    expect(federated.passwordChangedAt).toBeNull();
  });

  it('moves when the password is changed, and clears when it is removed', async () => {
    const user = await createUser({
      email: 'change@example.com',
      provider: 'credentials',
      subject: 'change@example.com',
      passwordHash: 'first',
    });
    const created = user.passwordChangedAt;

    await tick();
    await updateUserPassword(user.id, 'second');
    const changed = await changedAt(user.id);
    expect(changed).not.toBeNull();
    expect(changed! > created!).toBe(true);

    await removeUserPassword(user.id);
    expect(await changedAt(user.id)).toBeNull();
  });

  it('moves updatedAt too, whichever path sets the password', async () => {
    // A password is a security-relevant field: a row whose password just changed must not still
    // read as untouched. markPasswordChanged is the path Better Auth's own endpoints take, which
    // writes the hash itself and so never reaches updateUserPassword.
    const user = await createUser({
      email: 'touched@example.com',
      provider: 'credentials',
      subject: 'touched@example.com',
      passwordHash: 'first',
    });

    await tick();
    await updateUserPassword(user.id, 'second');
    const afterUpdate = (await getUserById(user.id))!;
    expect(afterUpdate.updatedAt > user.updatedAt).toBe(true);

    await tick();
    await markPasswordChanged(user.id);
    const afterMark = (await getUserById(user.id))!;
    expect(afterMark.passwordChangedAt! > afterUpdate.passwordChangedAt!).toBe(true);
    expect(afterMark.updatedAt > afterUpdate.updatedAt).toBe(true);
  });

  it('counts a credential account as a password even with no hash on the user row', async () => {
    // How a self-registered user looks: Better Auth writes the account, never users.passwordHash.
    const [row] = await ctx.db
      .insert(users)
      .values({
        email: 'self@example.com',
        provider: 'credentials',
        subject: 'self@example.com',
        role: 'user',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning();
    await ctx.db.insert(accounts).values({
      userId: row!.id,
      accountId: String(row!.id),
      providerId: 'credential',
      password: 'hash',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect((await usersWithPassword()).has(row!.id)).toBe(true);
  });
});

describe('the environment-seeded admin', () => {
  it('is dated when first seeded, and only again when ADMIN_PASSWORD really changes', async () => {
    process.env.ADMIN_USERNAME = 'envadmin';
    process.env.ADMIN_PASSWORD = 'EnvPassword2026!';

    await ensureAdminUser();
    const seeded = await changedAt(1);
    expect(seeded).not.toBeNull();

    // A restart with the same password is not a change.
    await tick();
    await ensureAdminUser();
    expect(await changedAt(1)).toBe(seeded);
    const [account] = await ctx.db.select().from(accounts).where(eq(accounts.userId, 1));
    expect(account?.password).toBeTruthy();

    // A restart with a different ADMIN_PASSWORD. config caches the variable for the life of the
    // process, so the stored hash and the applied-environment marker are rewound instead.
    await tick();
    const previous = await hashPassword('PreviousPassword2026!');
    await ctx.db.update(users).set({ passwordHash: previous }).where(eq(users.id, 1));
    await ctx.db
      .update(settings)
      .set({ value: JSON.stringify({ v: 2, username: 'envadmin', passwordHash: previous }) })
      .where(eq(settings.key, 'admin_env_credentials_fingerprint'));
    await ensureAdminUser();
    const changed = await changedAt(1);
    expect(changed! > seeded!).toBe(true);
  });
});
