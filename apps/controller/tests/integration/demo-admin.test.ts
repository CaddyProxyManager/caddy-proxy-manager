/**
 * The shared demo account: every visitor signs in as it, so in demo mode nobody may disable,
 * delete or demote it or change its password - the next visitor would be locked out until the demo
 * resets. Outside demo mode the same account is an ordinary one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
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
}));

import {
  createUser,
  deleteUser,
  getUserById,
  removeUserPassword,
  updateUserPassword,
  updateUserRole,
  updateUserStatus,
} from '../../src/lib/models/user';
import { ensureAdminUser } from '../../src/lib/init-db';
import { accounts, users } from '../../src/lib/db/schema';

const TOUCHED_ENV = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'DEMO_MODE'];

beforeEach(async () => {
  await ctx.db.delete(accounts);
  await ctx.db.delete(users);
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin';
  await ensureAdminUser();
});

afterEach(() => {
  for (const name of TOUCHED_ENV) delete process.env[name];
});

describe('the demo administrator', () => {
  it('cannot be disabled, deleted, demoted or have its password changed in demo mode', async () => {
    process.env.DEMO_MODE = 'true';
    for (const attempt of [
      () => updateUserStatus(1, 'disabled'),
      () => deleteUser(1),
      () => updateUserRole(1, 'viewer'),
      () => updateUserPassword(1, 'new-hash'),
      () => removeUserPassword(1),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'demoAdminProtected', status: 403 });
    }

    const admin = await getUserById(1);
    expect(admin).toMatchObject({ status: 'active', role: 'admin' });
  });

  it('can still be re-enabled or kept an admin, which lock nobody out', async () => {
    process.env.DEMO_MODE = 'true';
    await expect(updateUserStatus(1, 'active')).resolves.toMatchObject({ status: 'active' });
    await expect(updateUserRole(1, 'admin')).resolves.toMatchObject({ role: 'admin' });
  });

  it('leaves every other account alone in demo mode', async () => {
    process.env.DEMO_MODE = 'true';
    const other = await createUser({
      email: 'visitor@example.com',
      name: 'Visitor',
      role: 'user',
      provider: 'credentials',
      subject: 'visitor@example.com',
    });
    await expect(updateUserStatus(other.id, 'disabled')).resolves.toMatchObject({
      status: 'disabled',
    });
    await deleteUser(other.id);
    expect(await getUserById(other.id)).toBeNull();
  });

  it('is named Demo Admin in demo mode, renaming one seeded under another name', async () => {
    expect(await getUserById(1)).toMatchObject({ name: 'admin' });
    process.env.DEMO_MODE = 'true';
    await ensureAdminUser();
    expect(await getUserById(1)).toMatchObject({ name: 'Demo Admin' });
  });

  it('is an ordinary account outside demo mode', async () => {
    // Another admin first: the last active one can't be disabled, demo or not.
    await createUser({
      email: 'second-admin@localhost',
      role: 'admin',
      provider: 'credentials',
      subject: 'second-admin',
    });
    await expect(updateUserStatus(1, 'disabled')).resolves.toMatchObject({ status: 'disabled' });
  });
});

describe('the demo password', () => {
  // config.ts reads the environment once at load, so production is checked in a process of its own.
  async function adminPasswordIn(env: Record<string, string>): Promise<string> {
    const proc = Bun.spawn(
      [process.execPath, '-e', 'console.log(require("./src/lib/config").config.adminPassword)'],
      {
        cwd: resolve(import.meta.dir, '../..'),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          NEXT_RUNTIME: 'nodejs',
          ADMIN_USERNAME: 'admin',
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return stdout.trim() || stderr;
  }

  it('may be "admin" in a production demo, and nowhere else', async () => {
    expect(await adminPasswordIn({ ADMIN_PASSWORD: 'admin', DEMO_MODE: 'true' })).toBe('admin');
    expect(await adminPasswordIn({ ADMIN_PASSWORD: 'admin', DEMO_MODE: 'false' })).toContain(
      "must not be 'admin'",
    );
  });
});
