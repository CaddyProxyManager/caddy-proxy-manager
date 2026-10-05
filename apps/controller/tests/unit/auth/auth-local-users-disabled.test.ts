/**
 * In OIDC-only mode better-auth must not accept credentials at all - hiding the login form is
 * cosmetic, the endpoints have to be off. The flag is read at config import, so it is hoisted.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { reloadConfig } from '@/tests/helpers/config';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => {
  process.env.AUTH_DISABLE_LOCAL_USERS = 'true';
  return { db: null as unknown as TestDb };
});

afterAll(async () => {
  delete process.env.AUTH_DISABLE_LOCAL_USERS;
});

const { createTestDb } = await import('../../helpers/db');

// Outside the factory: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

// config snapshots process.env on first evaluation, already past; re-read, it sees the flag.
await reloadConfig();

import { getAuth } from '../../../src/lib/auth/server';
import { DISABLED_AUTH_PATHS } from '../../../src/lib/auth/disabled-paths';
import { ensureAdminUser } from '../../../src/lib/db/init';
import { users } from '../../../src/lib/db/schema';

describe('the Better Auth instance', () => {
  it('is built with the endpoints the app replaces turned off', async () => {
    const auth = (await getAuth()) as any;
    expect(auth.options.disabledPaths).toEqual(DISABLED_AUTH_PATHS);
  });
});

describe('AUTH_DISABLE_LOCAL_USERS=true', () => {
  it('turns off better-auth email/password sign-in', async () => {
    const auth = (await getAuth()) as any;
    expect(auth.options.emailAndPassword.enabled).toBe(false);
  });

  it('seeds no bootstrap admin account', async () => {
    await ensureAdminUser();
    const rows = await ctx.db.select().from(users);
    expect(rows).toEqual([]);
  });
});
