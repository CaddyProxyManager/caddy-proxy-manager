/**
 * The proxy holds the 2FA policy and the setup flag for the process. Every path that writes them
 * must drop what is held, or a policy change waits for a restart.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
ctx.db = await createTestDb();
vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

const schema = await import('@/src/lib/db/schema');
const { mfaStandingForAccount } = await import('@/src/lib/auth/two-factor/policy');
const { saveTwoFactorPolicySettings, setSetting } = await import('@/src/lib/settings');
const { invalidateSettingsCache } = await import('@/src/lib/settings/resolve');
const { stageWrites } = await import('@/src/lib/settings/staging');
const { applyStagedSettings } = await import('@/src/lib/settings/apply');
const { isSetupCompleted, markSetupCompleted } = await import('@/src/lib/setup');

let adminId = 0;

/** An admin with a password and no second factor: what the policy is about. */
const standing = async () =>
  (
    await mfaStandingForAccount({
      id: adminId,
      role: 'admin',
      hasPassword: true,
      twoFactorEnabled: false,
    })
  ).status;

const ENFORCED = { mode: 'admins', graceDays: 0, since: '2020-01-01T00:00:00.000Z' };

beforeEach(async () => {
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users);
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(schema.users)
    .values({
      email: 'admin@example.com',
      name: 'Admin',
      passwordHash: 'x',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@example.com',
      username: 'admin',
      displayUsername: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.users.id });
  adminId = row.id;
});

describe('the held 2FA policy', () => {
  it('is held between reads, so a write behind its back is not seen', async () => {
    expect(await standing()).toBe('exempt');
    await ctx.db.insert(schema.settings).values({
      key: 'two_factor_policy',
      value: JSON.stringify(ENFORCED),
      updatedAt: new Date().toISOString(),
    });
    expect(await standing()).toBe('exempt');
    // What a restore, an import or a staged apply calls after writing the table.
    invalidateSettingsCache();
    expect(await standing()).toBe('required');
  });

  it('follows a save from Settings or the --lift-mfa-policy route', async () => {
    expect(await standing()).toBe('exempt');
    await saveTwoFactorPolicySettings({ mode: 'admins', graceDays: 0 });
    expect(await standing()).toBe('required');
    await saveTwoFactorPolicySettings({ mode: 'off' });
    expect(await standing()).toBe('exempt');
  });

  it('follows a plain setSetting', async () => {
    expect(await standing()).toBe('exempt');
    await setSetting('two_factor_policy', ENFORCED);
    expect(await standing()).toBe('required');
  });

  it('follows a staged apply', async () => {
    expect(await standing()).toBe('exempt');
    await stageWrites(adminId, new Map([['two_factor_policy', JSON.stringify(ENFORCED)]]));
    // Staged is not applied: the proxy keeps enforcing what is stored.
    expect(await standing()).toBe('exempt');
    await applyStagedSettings(adminId, 'Admin');
    expect(await standing()).toBe('required');
  });
});

describe('the held setup flag', () => {
  it('is read again until setup completes, then held', async () => {
    expect(await isSetupCompleted()).toBe(false);
    await markSetupCompleted();
    expect(await isSetupCompleted()).toBe(true);
  });

  it('is dropped by a restore or import, which can take it back', async () => {
    await markSetupCompleted();
    expect(await isSetupCompleted()).toBe(true);
    await ctx.db.delete(schema.settings);
    invalidateSettingsCache();
    expect(await isSetupCompleted()).toBe(false);
  });
});
