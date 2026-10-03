/**
 * A password set on an account that never had one - an SSO user adding one on Profile, or an
 * invitation - must sign in. Better Auth reads only the credential account, which such an account
 * starts without, so updating the user row alone left the password unusable.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadConfig } from '@/tests/helpers/config';
import { reloadDbModule } from '@/tests/helpers/fresh-db';

const cleanups: Array<() => void | Promise<void>> = [];

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  resetDbModuleState();
});

async function boot() {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());

  process.env.DATABASE_URL = database.url;
  delete process.env.CPM_EPHEMERAL_DB;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  resetDbModuleState();

  await reloadConfig();

  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());

  const users = await import('@/src/lib/models/user');
  const { hashPassword } = await import('@/src/lib/password');
  const authServer = await import('@/src/lib/auth-server');
  // Or getAuth() hands back the instance built on the previous boot's database.
  authServer.invalidateProviderCache();
  // betterAuth's instance type is generated from its config; the test tree allows `any`.
  const auth = (await authServer.getAuth()) as any;

  const signIn = async (username: string, password: string) =>
    (await auth.api.signInUsername({ body: { username, password }, asResponse: true })).status;

  return { db: dbModule.default, schema, users, hashPassword, signIn };
}

describe('a first password', () => {
  it('signs in an SSO account that adds one', async () => {
    const { db, schema, users, hashPassword, signIn } = await boot();
    const user = await users.createUser({
      email: 'sso@example.com',
      provider: 'oidc',
      subject: 'sso-subject',
    });
    const now = new Date().toISOString();
    await db.insert(schema.accounts).values({
      userId: user.id,
      accountId: 'sso-subject',
      providerId: 'oidc',
      createdAt: now,
      updatedAt: now,
    });
    expect((await users.usersWithPassword()).has(user.id)).toBe(false);

    await users.updateUserPassword(user.id, await hashPassword('First-password-2026!'));

    expect((await users.usersWithPassword()).has(user.id)).toBe(true);
    expect(await signIn('sso@example.com', 'First-password-2026!')).toBe(200);
  });

  it('signs in an invited local account that was created without one', async () => {
    const { users, hashPassword, signIn } = await boot();
    const user = await users.createUser({
      email: 'invited@example.com',
      provider: 'credentials',
      subject: 'invited@example.com',
    });
    expect(await signIn('invited@example.com', 'Chosen-password-2026!')).not.toBe(200);

    await users.updateUserPassword(user.id, await hashPassword('Chosen-password-2026!'));

    expect(await signIn('invited@example.com', 'Chosen-password-2026!')).toBe(200);
  });

  it('replaces an existing password rather than adding a second account', async () => {
    const { db, schema, users, hashPassword, signIn } = await boot();
    const user = await users.createUser({
      email: 'local@example.com',
      provider: 'credentials',
      subject: 'local@example.com',
      passwordHash: await hashPassword('Old-password-2026!'),
    });

    await users.updateUserPassword(user.id, await hashPassword('New-password-2026!'));

    const credentials = (await db.select().from(schema.accounts)).filter(
      (account: { userId: number; providerId: string }) =>
        account.userId === user.id && account.providerId === 'credential',
    );
    expect(credentials).toHaveLength(1);
    expect(await signIn('local@example.com', 'New-password-2026!')).toBe(200);
    expect(await signIn('local@example.com', 'Old-password-2026!')).not.toBe(200);
  });
});
