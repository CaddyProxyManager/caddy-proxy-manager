/**
 * Emailed password links end to end, against a real database: who gets one, what the message
 * carries, and that a link sets the password exactly once.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import net from 'node:net';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// A Bun mock factory must be synchronous, so the database is made first.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));

import { eq } from 'drizzle-orm';
import { accounts, auditEvents, sessions, users, verifications } from '../../src/lib/db/schema';
import { DomainError } from '../../src/lib/domain-error';
import {
  type OutgoingEmail,
  sendEmail,
  setEmailDeliveryForTests,
} from '../../src/lib/email/transport';
import { createUser, usersWithPassword } from '../../src/lib/models/user';
import { issueEmailedLink } from '../../src/lib/models/emailed-links';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import {
  completeEmailedLink,
  describeEmailedLink,
  requestPasswordReset,
  sendEmailedLink,
} from '../../src/lib/services/emailed-links';
import { invalidateSettingsCache } from '../../src/lib/settings/resolve';

const SMTP_ENV = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_FROM: 'proxy@example.com',
};
const TOUCHED_ENV = [
  'SMTP_ENABLED',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURITY',
  'SMTP_USERNAME',
  'SMTP_PASSWORD',
  'SMTP_FROM',
  'APP_NAME',
];

let sent: OutgoingEmail[] = [];

function configureEmail(env: Record<string, string> = SMTP_ENV) {
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  invalidateSettingsCache();
}

function tokenFrom(message: OutgoingEmail): string {
  const match = /\/login\/reset-password#([\w-]+)/.exec(message.text);
  if (!match) throw new Error(`no link in: ${message.text}`);
  return match[1];
}

async function localUser(email = 'alice@example.com', password = 'Old-password-1') {
  return createUser({
    email,
    provider: 'credentials',
    subject: email,
    passwordHash: await hashPassword(password),
  });
}

async function expectInvalidLink(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe('passwordLinkInvalid');
}

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  invalidateSettingsCache();
  sent = [];
  setEmailDeliveryForTests(async (_config, message) => {
    sent.push(message);
  });
  await ctx.db.delete(verifications);
  await ctx.db.delete(sessions);
  await ctx.db.delete(accounts);
  await ctx.db.delete(auditEvents);
  await ctx.db.delete(users);
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  for (const name of TOUCHED_ENV) delete process.env[name];
});

describe('requestPasswordReset', () => {
  it('emails a local account a link that sets its password once', async () => {
    configureEmail();
    const user = await localUser();
    await ctx.db.insert(sessions).values({
      userId: user.id,
      token: 'old-session',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await requestPasswordReset('ALICE@example.com', 'en');

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('alice@example.com');
    expect(sent[0].from).toEqual({ name: 'Caddy Proxy Manager', address: 'proxy@example.com' });
    const token = tokenFrom(sent[0]);
    expect(sent[0].html).toContain(`#${token}`);
    expect(await describeEmailedLink(token)).toEqual({
      purpose: 'reset',
      username: 'alice@example.com',
    });

    expect(await completeEmailedLink(token, 'New-password-2')).toEqual({
      userId: user.id,
      purpose: 'reset',
    });
    const [row] = await ctx.db.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword('New-password-2', row.passwordHash ?? '')).toBe(true);
    const [account] = await ctx.db.select().from(accounts).where(eq(accounts.userId, user.id));
    expect(await verifyPassword('New-password-2', account.password ?? '')).toBe(true);
    // The old password's sessions go with it.
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, user.id))).toEqual([]);

    await expectInvalidLink(completeEmailedLink(token, 'Another-password-3'));
    expect(await describeEmailedLink(token)).toBeNull();
  });

  it('matches the username too, not just the address', async () => {
    configureEmail();
    const user = await localUser();
    await ctx.db.update(users).set({ username: 'alice' }).where(eq(users.id, user.id));

    await requestPasswordReset('alice', 'en');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('alice@example.com');
  });

  it('sends nothing for an unknown, disabled or single sign-on account', async () => {
    configureEmail();
    const disabled = await localUser('disabled@example.com');
    await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, disabled.id));
    await createUser({ email: 'sso@example.com', provider: 'oidc', subject: 'sso-subject' });

    await requestPasswordReset('nobody@example.com', 'en');
    await requestPasswordReset('disabled@example.com', 'en');
    await requestPasswordReset('sso@example.com', 'en');

    expect(sent).toEqual([]);
    expect(await ctx.db.select().from(verifications)).toEqual([]);
  });

  it('sends nothing while email is off or incomplete', async () => {
    await localUser();
    await requestPasswordReset('alice@example.com', 'en');

    configureEmail({ SMTP_HOST: 'smtp.example.com' });
    await requestPasswordReset('alice@example.com', 'en');

    configureEmail({ ...SMTP_ENV, SMTP_ENABLED: 'false' });
    await requestPasswordReset('alice@example.com', 'en');

    expect(sent).toEqual([]);
  });

  it('leaves only the newest link working', async () => {
    configureEmail();
    await localUser();
    await requestPasswordReset('alice@example.com', 'en');
    await requestPasswordReset('alice@example.com', 'en');

    const [older, newer] = sent.map(tokenFrom);
    await expectInvalidLink(completeEmailedLink(older, 'New-password-2'));
    await completeEmailedLink(newer, 'New-password-2');
  });
});

describe('password links', () => {
  it('refuses an expired link', async () => {
    const user = await localUser();
    const { token } = await issueEmailedLink(user.id, 'reset', Date.now() - 2 * 60 * 60 * 1000);
    expect(await describeEmailedLink(token)).toBeNull();
    await expectInvalidLink(completeEmailedLink(token, 'New-password-2'));
  });

  it('refuses a link for an account disabled since it was sent', async () => {
    const user = await localUser();
    const { token } = await issueEmailedLink(user.id, 'reset');
    await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, user.id));
    await expectInvalidLink(completeEmailedLink(token, 'New-password-2'));
  });
});

describe('sendEmailedLink', () => {
  it('invites an account without a password, which then signs in with the one chosen', async () => {
    configureEmail();
    const user = await createUser({
      email: 'bob@example.com',
      provider: 'credentials',
      subject: 'bob@example.com',
    });

    expect(await sendEmailedLink(user.id, 'Avery', 'en')).toBe('invite');
    expect(sent[0].subject).toContain('invited');
    expect(sent[0].text).toContain('Avery created an account for bob@example.com');

    const token = tokenFrom(sent[0]);
    expect((await describeEmailedLink(token))?.purpose).toBe('invite');
    await completeEmailedLink(token, 'Chosen-password-1');
    // Better Auth signs in from the credential account, which an invitation starts without.
    expect((await usersWithPassword()).has(user.id)).toBe(true);
  });

  it('sends a reset link to an account that has a password', async () => {
    configureEmail();
    const user = await localUser();
    expect(await sendEmailedLink(user.id, 'Avery', 'en')).toBe('reset');
    expect(sent[0].subject).toBe('Reset your Caddy Proxy Manager password');
  });

  it('refuses a single sign-on account', async () => {
    configureEmail();
    const user = await createUser({ email: 'sso@example.com', provider: 'oidc', subject: 'x' });
    const error = await sendEmailedLink(user.id, 'Avery', 'en').catch((caught: unknown) => caught);
    expect((error as DomainError).code).toBe('passwordLinkSsoAccount');
  });

  it('drops the link when the server refuses the message', async () => {
    configureEmail();
    const user = await localUser();
    setEmailDeliveryForTests(async () => {
      throw new Error('550 relay denied');
    });

    const error = await sendEmailedLink(user.id, 'Avery', 'en').catch((caught: unknown) => caught);
    expect((error as DomainError).code).toBe('emailSendFailed');
    expect((error as DomainError).params).toEqual({ detail: '550 relay denied' });
    expect(await ctx.db.select().from(verifications)).toEqual([]);
  });
});

/** Just enough SMTP to accept one message, and to leave STARTTLS out when asked. */
async function fakeSmtpServer() {
  const data: string[] = [];
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    socket.write('220 fake ESMTP\r\n');
    let inData = false;
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\r\n')) {
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          } else data.push(line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (!verb) continue;
        commands.push(verb);
        // AUTH offered but STARTTLS not: a client that signs in anyway sends the password in clear.
        if (verb === 'EHLO') socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') socket.write('235 accepted\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, data, commands, port: (server.address() as net.AddressInfo).port };
}

describe('SMTP delivery', () => {
  it('sends over a plain relay, quoting an application name that holds a comma', async () => {
    setEmailDeliveryForTests(null);
    const { server, data, port } = await fakeSmtpServer();
    try {
      configureEmail({
        ...SMTP_ENV,
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(port),
        SMTP_SECURITY: 'none',
        APP_NAME: 'Proxy, Inc.',
      });
      await sendEmail({ to: 'alice@example.com', subject: 'Hello', text: 'Body' });
      expect(data).toContain('From: "Proxy, Inc." <proxy@example.com>');
      expect(data).toContain('Subject: Hello');
    } finally {
      server.close();
    }
  });

  it('refuses to authenticate in the clear when STARTTLS is required but not offered', async () => {
    setEmailDeliveryForTests(null);
    const { server, data, commands, port } = await fakeSmtpServer();
    try {
      configureEmail({
        ...SMTP_ENV,
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(port),
        SMTP_SECURITY: 'starttls',
        SMTP_USERNAME: 'user',
        SMTP_PASSWORD: 'secret',
      });
      const error = await sendEmail({ to: 'a@example.com', subject: 'x', text: 'y' }).catch(
        (caught: unknown) => caught,
      );
      expect((error as DomainError).code).toBe('emailSendFailed');
      expect(commands).not.toContain('AUTH');
      expect(data).toEqual([]);
    } finally {
      server.close();
    }
  });
});
