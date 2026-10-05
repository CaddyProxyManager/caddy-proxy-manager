/**
 * Email self-registration against a real database. In e2e a failure is a bare 422 - Better Auth
 * hides the database message - so this boots the same code where it surfaces.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadConfig } from '@/tests/helpers/config';
import { reloadDbModule } from '@/tests/helpers/fresh-db';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';

// The sign-up hook words a password refusal through next-intl, which needs a request scope.
vi.mock('next-intl/server', () => nextIntlServerMock());

const cleanups: Array<() => void | Promise<void>> = [];

/** Carries the body into the compared value, since Bun's `expect` takes no message argument. */
async function statusAndBody(response: Response): Promise<string> {
  if (response.status === 200) return '200';
  return `${response.status}: ${await response.text()}`;
}

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
  delete process.env.AUTH_ALLOW_SELF_REGISTRATION;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  resetDbModuleState();
});

/**
 * As :3001 runs in e2e. `seedAdmin` runs instrumentation.ts's bootstrap, whose explicit-id admin
 * insert is what the e2e failure needed to reproduce.
 */
async function bootWithSelfRegistration({ seedAdmin = false } = {}) {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());

  process.env.DATABASE_URL = database.url;
  // The startup migrations must run: this asserts a real first request, not an empty schema.
  delete process.env.CPM_EPHEMERAL_DB;
  process.env.AUTH_ALLOW_SELF_REGISTRATION = 'true';
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  resetDbModuleState();

  // config.ts snapshots env at load; a stale copy leaves signup disabled.
  await reloadConfig();

  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());

  if (seedAdmin) {
    process.env.ADMIN_USERNAME = 'testadmin';
    process.env.ADMIN_PASSWORD = 'TestPassword2026!';
    const initDb = await import('@/src/lib/db/init');
    await initDb.ensureAdminUser();
  }

  const authServer = await import('@/src/lib/auth/server');
  // Or getAuth() hands back the instance built on the previous boot's database.
  authServer.invalidateProviderCache();
  // betterAuth's instance type is generated from its config; the test tree allows `any`.
  const auth = (await authServer.getAuth()) as any;
  return { auth, db: dbModule.default, schema };
}

describe('email self-registration', () => {
  it('creates the user and its credential account', async () => {
    const { auth, db, schema } = await bootWithSelfRegistration();
    const email = `self-registration-${Date.now()}@test.invalid`;

    const response = await auth.api.signUpEmail({
      body: { name: 'Self Registration Test', email, password: 'SelfRegistration2026!' },
      asResponse: true,
    });

    // The body carries the adapter's complaint.
    expect(await statusAndBody(response)).toBe('200');

    const users = await db.select().from(schema.users);
    const created = users.find((user: { email: string }) => user.email === email);
    expect(created, 'signup should have created the user').toBeDefined();
    expect(created?.role).toBe('user');
    expect(created?.status).toBe('active');
    // Better Auth bypasses models/user here, so only the account hook can date it.
    expect(created?.passwordChangedAt).toBeTruthy();

    const accounts = await db.select().from(schema.accounts);
    const credential = accounts.find(
      (account: { userId: number; providerId: string }) =>
        account.userId === created?.id && account.providerId === 'credential',
    );
    expect(credential, 'signup should have written a credential account').toBeDefined();
    expect(credential?.password).toBeTruthy();
  });

  it('creates a user alongside the bootstrap admin', async () => {
    // The explicit-id admin insert leaves the sequence at 1; without ensureAdminUser resyncing it
    // this signup collides on the primary key and Better Auth answers 422.
    const { auth, db, schema } = await bootWithSelfRegistration({ seedAdmin: true });
    const email = `after-admin-${Date.now()}@test.invalid`;

    const response = await auth.api.signUpEmail({
      body: { name: 'After Admin', email, password: 'SelfRegistration2026!' },
      asResponse: true,
    });
    expect(await statusAndBody(response)).toBe('200');

    const users = await db.select().from(schema.users);
    const created = users.find((user: { email: string }) => user.email === email);
    expect(created, 'signup should have created the user').toBeDefined();
    expect(created?.id).not.toBe(1);
    expect(users.find((user: { id: number }) => user.id === 1)?.role).toBe('admin');
  });

  it('refuses a second signup for the same address', async () => {
    const { auth } = await bootWithSelfRegistration();
    const email = `duplicate-${Date.now()}@test.invalid`;
    const body = { name: 'Duplicate', email, password: 'SelfRegistration2026!' };

    const first = await auth.api.signUpEmail({ body, asResponse: true });
    expect(await statusAndBody(first)).toBe('200');

    const second = await auth.api.signUpEmail({ body, asResponse: true });
    expect(second.status).not.toBe(200);
  });
});
