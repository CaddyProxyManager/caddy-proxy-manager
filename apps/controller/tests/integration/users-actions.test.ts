/**
 * The Users page's actions against a real database: what each one stores, what it audits, and the
 * refusals a public endpoint must make itself - your own role, status or account, a role outside
 * the allowlist, local users switched off. A refusal comes back as the catalog's sentence.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, callerId: 1 }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  requireAdmin: vi.fn(async () => ({
    user: { id: String(ctx.callerId), role: 'admin', name: 'Admin', email: 'admin@example.com' },
  })),
}));

import { and, eq } from 'drizzle-orm';
import messages from '../../messages/en.json';
import {
  createUserAction,
  deleteUserAction,
  resetUserTwoFactorAction,
  sendEmailedLinkAction,
  updateUserInfoAction,
  updateUserRoleAction,
  updateUserStatusAction,
} from '@/src/app/(dashboard)/users/actions';
import { logAuditEvent } from '@/src/lib/audit';
import { domainErrorMessage } from '@/src/lib/domain-error';
import { type OutgoingEmail, setEmailDeliveryForTests } from '@/src/lib/email/transport';
import { verifyPassword } from '@/src/lib/password';
import { invalidateSettingsCache } from '@/src/lib/settings/resolve';
import {
  accounts,
  sessions,
  settings,
  twoFactors,
  users,
  verifications,
} from '../../src/lib/db/schema';

const NOW = '2026-03-01T00:00:00.000Z';
const PASSWORD = 'Correct-Horse-Battery-1!';
const ENV = ['AUTH_DISABLE_LOCAL_USERS', 'SMTP_HOST', 'SMTP_FROM'];

let sent: OutgoingEmail[] = [];

async function seedUser(email: string, role = 'user'): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      role,
      provider: 'credentials',
      subject: email,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: users.id });
  return row.id;
}

async function stored(userId: number) {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, userId));
  return row;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** setup.bun.ts replaces logAuditEvent with a mock. */
function auditRows() {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
}

function configureEmail() {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
}

let adminId: number;

beforeEach(async () => {
  for (const name of ENV) delete process.env[name];
  invalidateSettingsCache();
  sent = [];
  setEmailDeliveryForTests(async (_config, message) => {
    sent.push(message);
  });
  vi.mocked(logAuditEvent).mockClear();
  for (const table of [verifications, twoFactors, sessions, accounts, settings, users]) {
    await ctx.db.delete(table);
  }
  adminId = await seedUser('admin@example.com', 'admin');
  // A second admin, so demoting or deleting one never trips the last-admin guard.
  await seedUser('root@example.com', 'admin');
  ctx.callerId = adminId;
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  for (const name of ENV) delete process.env[name];
  invalidateSettingsCache();
});

describe('createUserAction', () => {
  it('creates a local account whose password signs in, and audits it', async () => {
    const result = await createUserAction(
      form({ email: ' Carol@Example.com ', name: ' Carol ', role: 'operator', password: PASSWORD }),
    );

    expect(result).toEqual({ status: 'success', message: undefined });
    const [row] = await ctx.db.select().from(users).where(eq(users.email, 'carol@example.com'));
    expect(row).toMatchObject({ name: 'Carol', role: 'operator', provider: 'credentials' });
    const [credential] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, row.id), eq(accounts.providerId, 'credential')));
    expect(await verifyPassword(PASSWORD, credential.password!)).toBe(true);
    expect(auditRows()).toEqual([
      expect.objectContaining({ userId: adminId, action: 'create', entityId: row.id }),
    ]);
    expect(sent).toEqual([]);
  });

  it('invites without a password, emailing the new account a link', async () => {
    configureEmail();

    const result = await createUserAction(form({ email: 'dave@example.com', invite: 'on' }));

    expect(result).toEqual({ status: 'success', message: undefined });
    const [row] = await ctx.db.select().from(users).where(eq(users.email, 'dave@example.com'));
    expect(row.passwordHash).toBeNull();
    expect(sent.map((message) => message.to)).toEqual(['dave@example.com']);
  });

  it('keeps an invited account when the email cannot go, and says so', async () => {
    const result = await createUserAction(form({ email: 'erin@example.com', invite: 'on' }));

    expect(result.status).toBe('success');
    expect(result.message).toContain(messages.errors.emailNotConfigured);
    expect(
      await ctx.db.select().from(users).where(eq(users.email, 'erin@example.com')),
    ).toHaveLength(1);
  });

  it.each([
    [{ email: 'x@example.com' }, 'emailAndPasswordRequired'],
    [{ password: PASSWORD }, 'emailAndPasswordRequired'],
    [{ email: 'x@example.com', password: PASSWORD, role: 'root' }, 'invalidUserRole'],
  ] as const)('refuses %p and creates nobody', async (fields, code) => {
    const result = await createUserAction(form(fields));

    expect(result).toEqual({ status: 'error', message: domainErrorMessage(code) });
    expect(await ctx.db.select().from(users)).toHaveLength(2);
    expect(auditRows()).toEqual([]);
  });

  it('refuses a weak password', async () => {
    const result = await createUserAction(form({ email: 'x@example.com', password: 'short' }));
    expect(result.status).toBe('error');
    expect(await ctx.db.select().from(users)).toHaveLength(2);
  });

  it('refuses every local account in OIDC-only mode', async () => {
    process.env.AUTH_DISABLE_LOCAL_USERS = 'true';
    invalidateSettingsCache();

    const result = await createUserAction(form({ email: 'x@example.com', password: PASSWORD }));

    expect(result).toEqual({
      status: 'error',
      message: domainErrorMessage('localUserCreationDisabled'),
    });
    expect(await ctx.db.select().from(users)).toHaveLength(2);
  });
});

describe('updateUserRoleAction', () => {
  it('changes the role and audits it', async () => {
    const userId = await seedUser('alice@example.com');

    expect(await updateUserRoleAction(userId, 'viewer')).toEqual({ status: 'success' });

    expect((await stored(userId)).role).toBe('viewer');
    expect(auditRows()).toEqual([
      expect.objectContaining({ action: 'update', entityId: userId, userId: adminId }),
    ]);
  });

  it("refuses the caller's own role", async () => {
    const result = await updateUserRoleAction(adminId, 'viewer');
    expect(result).toEqual({ status: 'error', message: domainErrorMessage('cannotChangeOwnRole') });
    expect((await stored(adminId)).role).toBe('admin');
  });

  it('refuses a role outside the allowlist', async () => {
    const userId = await seedUser('alice@example.com');
    const result = await updateUserRoleAction(userId, 'superuser' as never);
    expect(result).toEqual({ status: 'error', message: domainErrorMessage('invalidUserRole') });
    expect((await stored(userId)).role).toBe('user');
    expect(auditRows()).toEqual([]);
  });
});

describe('updateUserStatusAction', () => {
  it('disables a user and ends their sessions', async () => {
    const userId = await seedUser('alice@example.com');
    await ctx.db.insert(sessions).values({
      userId,
      token: 'alice-session',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(await updateUserStatusAction(userId, 'disabled')).toEqual({ status: 'success' });

    expect((await stored(userId)).status).toBe('disabled');
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);
    expect(auditRows()[0].summary).toContain('disabled');
  });

  it("refuses the caller's own status and a status that does not exist", async () => {
    const userId = await seedUser('alice@example.com');
    expect(await updateUserStatusAction(adminId, 'disabled')).toEqual({
      status: 'error',
      message: domainErrorMessage('cannotChangeOwnStatus'),
    });
    expect(await updateUserStatusAction(userId, 'frozen')).toEqual({
      status: 'error',
      message: domainErrorMessage('invalidUserStatus'),
    });
    expect((await stored(adminId)).status).toBe('active');
    expect((await stored(userId)).status).toBe('active');
  });
});

describe('updateUserInfoAction', () => {
  it('answers a user that does not exist', async () => {
    const result = await updateUserInfoAction(99999, form({ name: 'Ghost' }));
    expect(result).toEqual({ status: 'error', message: domainErrorMessage('userNotFound') });
  });
});

describe('deleteUserAction', () => {
  it('deletes another user and audits it', async () => {
    const userId = await seedUser('alice@example.com');

    expect(await deleteUserAction(userId)).toEqual({ status: 'success' });

    expect(await stored(userId)).toBeUndefined();
    expect(auditRows()).toEqual([
      expect.objectContaining({ action: 'delete', entityType: 'user', entityId: userId }),
    ]);
  });

  it("refuses the caller's own account", async () => {
    expect(await deleteUserAction(adminId)).toEqual({
      status: 'error',
      message: domainErrorMessage('cannotDeleteOwnAccount'),
    });
    expect(await stored(adminId)).toBeDefined();
  });

  it('refuses the last active administrator', async () => {
    const [root] = await ctx.db.select().from(users).where(eq(users.email, 'root@example.com'));
    await ctx.db.update(users).set({ role: 'user' }).where(eq(users.id, adminId));

    const result = await deleteUserAction(root.id);

    expect(result).toEqual({ status: 'error', message: domainErrorMessage('lastActiveAdmin') });
    expect(await stored(root.id)).toBeDefined();
  });
});

describe('resetUserTwoFactorAction', () => {
  it("removes the user's second factor and signs them out everywhere", async () => {
    const userId = await seedUser('alice@example.com');
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, userId));
    await ctx.db.insert(twoFactors).values({ userId, secret: 's', backupCodes: '[]' });
    await ctx.db.insert(sessions).values({
      userId,
      token: 'alice-session',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await resetUserTwoFactorAction(userId);

    expect(result).toEqual({ status: 'success', message: messages.users.twoFactorResetDone });
    expect((await stored(userId)).twoFactorEnabled).toBe(false);
    expect(await ctx.db.select().from(twoFactors)).toEqual([]);
    expect(await ctx.db.select().from(sessions)).toEqual([]);
    expect(auditRows()).toEqual([
      expect.objectContaining({ action: 'two_factor_reset', entityId: userId }),
    ]);
  });

  it("refuses the caller's own, and a user that does not exist", async () => {
    expect(await resetUserTwoFactorAction(adminId)).toEqual({
      status: 'error',
      message: domainErrorMessage('cannotResetOwnTwoFactor'),
    });
    expect(await resetUserTwoFactorAction(99999)).toEqual({
      status: 'error',
      message: domainErrorMessage('userNotFound'),
    });
    expect(auditRows()).toEqual([]);
  });
});

describe('sendEmailedLinkAction', () => {
  it('sends an invitation to an account without a password, and a reset link to one with', async () => {
    configureEmail();
    const invited = await seedUser('invited@example.com');
    const withPassword = await seedUser('member@example.com');
    await ctx.db.update(users).set({ passwordHash: 'x' }).where(eq(users.id, withPassword));

    const invite = await sendEmailedLinkAction(invited);
    const reset = await sendEmailedLinkAction(withPassword);

    expect(invite.message).toBe(
      messages.users.inviteSent.replace('{email}', 'invited@example.com'),
    );
    expect(reset.message).toBe(
      messages.users.resetLinkSent.replace('{email}', 'member@example.com'),
    );
    expect(sent.map((message) => message.to)).toEqual([
      'invited@example.com',
      'member@example.com',
    ]);
    expect(auditRows().map((event) => event.action)).toEqual([
      'password_link_sent',
      'password_link_sent',
    ]);
  });

  it('answers with the reason when email is not configured', async () => {
    const userId = await seedUser('alice@example.com');
    expect(await sendEmailedLinkAction(userId)).toEqual({
      status: 'error',
      message: domainErrorMessage('emailNotConfigured'),
    });
    expect(auditRows()).toEqual([]);
  });
});
