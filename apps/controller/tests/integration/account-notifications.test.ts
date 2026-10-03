/** The account-security notifications: auto-disable, the last admin kept, admin locks, new admins. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const schemaModule = await import('@/src/lib/db/schema');
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

const { recordAccountFailure } = await import('@/src/lib/account-failures');
type AccountLockPolicy = import('@/src/lib/rate-limit').AccountLockPolicy;
const { accountKey, DEFAULT_ACCOUNT_LOCK, resetAccountFailures } = await import(
  '@/src/lib/rate-limit'
);
const { createUser, updateUserRole } = await import('@/src/lib/models/user');
const { markSetupCompleted } = await import('@/src/lib/setup');
const { flushNotifications, resetNotificationsForTests } = await import('@/src/lib/notifications');
const { BATCH_MS } = await import('@/src/lib/notifications/plan');
const { setEmailDeliveryForTests } = await import('@/src/lib/email/transport');
const { invalidateSettingsCache } = await import('@/src/lib/settings/resolve');
const { users, settings, sessions } = schemaModule;

type Sent = { to: string | string[]; subject: string; text: string };
let sent: Sent[] = [];
const POLICY = { ...DEFAULT_ACCOUNT_LOCK, disableAfter: 3 };
const flushLater = () => flushNotifications(Date.now() + BATCH_MS);

async function account(email: string, username: string, role = 'user') {
  return createUser({
    email,
    username,
    role: role as 'user',
    provider: 'credentials',
    subject: email,
  });
}

async function fail(name: string, times: number, policy: AccountLockPolicy = POLICY) {
  for (let i = 0; i < times; i++) {
    await recordAccountFailure(accountKey(name), 'local', Date.now(), policy);
  }
}

beforeEach(async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
  sent = [];
  setEmailDeliveryForTests(async (_config, message) => {
    sent.push(message);
  });
  await ctx.db.delete(sessions);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
  await resetNotificationsForTests();
  for (const name of ['alice', 'root']) resetAccountFailures(accountKey(name));
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  invalidateSettingsCache();
});

describe('account-security notifications', () => {
  it('tells the administrators an account was disabled after failed sign-ins', async () => {
    await account('root@example.com', 'root', 'admin');
    await account('alice@example.com', 'alice');
    await fail('alice', 3);
    await flushLater();

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['root@example.com']);
    expect(sent[0].subject).toBe('Caddy Proxy Manager: Account disabled after failed sign-ins');
    expect(sent[0].text).toContain('alice@example.com was disabled after 3 failed sign-ins');
  });

  it('says the last administrator was kept, once', async () => {
    await account('root@example.com', 'root', 'admin');
    await fail('root', 5);
    await flushLater();

    expect(sent.map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: Last administrator kept enabled',
    ]);
    expect(sent[0].text).toContain('root@example.com reached 3 failed sign-ins');
  });

  it('tells when the lock engages on an administrator', async () => {
    await account('root@example.com', 'root', 'admin');
    await fail('root', 8, DEFAULT_ACCOUNT_LOCK);
    await flushLater();

    expect(sent.map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: Administrator account locked',
    ]);
    expect(sent[0].text).toContain('root@example.com was locked after 6 failed sign-ins');
  });

  it('tells about a new administrator once setup is done, created or promoted', async () => {
    // Setup's own first administrator is no news.
    await account('root@example.com', 'root', 'admin');
    await flushLater();
    expect(sent).toHaveLength(0);

    await markSetupCompleted();
    await account('second@example.com', 'second', 'admin');
    const promoted = await account('carol@example.com', 'carol');
    await updateUserRole(promoted.id, 'admin');
    // Already one: no news.
    await updateUserRole(promoted.id, 'admin');
    await flushLater();

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Caddy Proxy Manager: 2 notifications');
    expect(sent[0].text).toContain('A new administrator account was created: second@example.com.');
    expect(sent[0].text).toContain('carol@example.com was made an administrator.');
  });

  it('sends nothing with the switch off', async () => {
    process.env.NOTIFY_ACCOUNT_DISABLED = 'false';
    invalidateSettingsCache();
    try {
      await account('root@example.com', 'root', 'admin');
      await account('alice@example.com', 'alice');
      await fail('alice', 3);
      await flushLater();
      expect(sent).toHaveLength(0);
    } finally {
      delete process.env.NOTIFY_ACCOUNT_DISABLED;
      invalidateSettingsCache();
    }
  });
});
