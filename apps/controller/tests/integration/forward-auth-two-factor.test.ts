/**
 * The forward-auth portal signs in without Better Auth, so it must ask for the second factor
 * itself, or every forward-auth host would take a password alone from a 2FA account.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { NextRequest } from 'next/server';
import { createOTP } from '@better-auth/utils/otp';
import { symmetricEncrypt } from 'better-auth/crypto';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');
const { testTranslator } = await import('../helpers/next-intl');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  },
}));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => testTranslator(namespace),
}));

import { eq } from 'drizzle-orm';
import * as schema from '../../src/lib/db/schema';
import { config } from '../../src/lib/config';
import { POST as login } from '../../src/app/api/forward-auth/login/route';
import { POST as verifyCode } from '../../src/app/api/forward-auth/login/verify/route';
import { createRedirectIntent } from '../../src/lib/models/forward-auth';
import { hashPassword } from '../../src/lib/password';
import { accountKey, resetAccountFailures } from '../../src/lib/rate-limit';
import { TWO_FACTOR_MAX_FAILURES, resetTwoFactor } from '../../src/lib/two-factor';

const PASSWORD = 'correct horse battery staple';
const TARGET = 'https://app.example.com/dashboard';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const BACKUP_CODES = ['AAAAA-11111', 'BBBBB-22222'];
const now = () => new Date().toISOString();
let ipCounter = 0;

async function setup({ twoFactor }: { twoFactor: boolean }) {
  const timestamp = now();
  const [user] = await ctx.db
    .insert(schema.users)
    .values({
      email: 'alice@localhost',
      name: 'Alice',
      role: 'user',
      provider: 'credentials',
      subject: 'alice',
      status: 'active',
      passwordHash: await hashPassword(PASSWORD),
      twoFactorEnabled: twoFactor,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  const [host] = await ctx.db
    .insert(schema.proxyHosts)
    .values({
      name: 'App',
      domains: JSON.stringify(['app.example.com']),
      upstreams: JSON.stringify(['backend:8080']),
      enabled: true,
      meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  await ctx.db.insert(schema.forwardAuthAccess).values({
    proxyHostId: host.id,
    userId: user.id,
    groupId: null,
    createdAt: timestamp,
  });
  if (twoFactor) {
    // Stored the way Better Auth's plugin stores it, with the key it uses.
    await ctx.db.insert(schema.twoFactors).values({
      userId: user.id,
      secret: await symmetricEncrypt({ key: config.sessionSecret, data: SECRET }),
      backupCodes: await symmetricEncrypt({
        key: config.sessionSecret,
        data: JSON.stringify(BACKUP_CODES),
      }),
      verified: true,
    });
  }
  return user;
}

const headers = () => ({
  origin: 'http://localhost:3000',
  'content-type': 'application/json',
  'x-forwarded-for': `203.0.113.${++ipCounter % 250}`,
});

async function passwordStep(rid: string) {
  const response = await login(
    new NextRequest('http://localhost:3000/api/forward-auth/login', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ username: 'alice', password: PASSWORD, rid }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function codeStep(body: Record<string, unknown>) {
  const response = await verifyCode(
    new NextRequest('http://localhost:3000/api/forward-auth/login/verify', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const totp = () => createOTP(SECRET, { digits: 6, period: 30 }).totp();

beforeEach(async () => {
  await ctx.db.delete(schema.twoFactors);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users);
  resetAccountFailures(accountKey('alice'));
});

describe('portal sign-in with 2FA', () => {
  it('signs in on the password alone when 2FA is off', async () => {
    await setup({ twoFactor: false });
    const { status, body } = await passwordStep(await createRedirectIntent(TARGET));
    expect(status).toBe(200);
    expect(String(body.redirectTo)).toStartWith('https://app.example.com/.cpm-auth/callback?code=');
  });

  it('asks for a code, and leaves the intent unspent until it checks out', async () => {
    await setup({ twoFactor: true });
    const rid = await createRedirectIntent(TARGET);
    const first = await passwordStep(rid);
    expect(first.status).toBe(200);
    expect(first.body.redirectTo).toBeUndefined();
    expect(first.body.needsSecondFactor).toBe(true);

    const done = await codeStep({ challenge: first.body.challenge, rid, code: await totp() });
    expect(done.status).toBe(200);
    expect(String(done.body.redirectTo)).toStartWith(
      'https://app.example.com/.cpm-auth/callback?code=',
    );
  });

  it('refuses a wrong code, then a replayed challenge after success', async () => {
    await setup({ twoFactor: true });
    const rid = await createRedirectIntent(TARGET);
    const { body } = await passwordStep(rid);

    expect((await codeStep({ challenge: body.challenge, rid, code: '000000' })).status).toBe(401);
    expect((await codeStep({ challenge: body.challenge, rid, code: await totp() })).status).toBe(
      200,
    );
    const replay = await codeStep({ challenge: body.challenge, rid, code: await totp() });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('CHALLENGE_EXPIRED');
  });

  it('binds the challenge to its intent', async () => {
    await setup({ twoFactor: true });
    const rid = await createRedirectIntent(TARGET);
    const other = await createRedirectIntent(TARGET);
    const { body } = await passwordStep(rid);
    const moved = await codeStep({ challenge: body.challenge, rid: other, code: await totp() });
    expect(moved.status).toBe(401);
    expect(moved.body.code).toBe('CHALLENGE_EXPIRED');
  });

  it('accepts a backup code once', async () => {
    await setup({ twoFactor: true });
    const rid = await createRedirectIntent(TARGET);
    const { body } = await passwordStep(rid);
    const code = BACKUP_CODES[0];
    expect(
      (await codeStep({ challenge: body.challenge, rid, code, method: 'backup' })).status,
    ).toBe(200);

    const rid2 = await createRedirectIntent(TARGET);
    const again = await passwordStep(rid2);
    expect(
      (await codeStep({ challenge: again.body.challenge, rid: rid2, code, method: 'backup' }))
        .status,
    ).toBe(401);
  });

  it('locks the account after too many wrong codes, across challenges', async () => {
    const user = await setup({ twoFactor: true });
    let failures = 0;
    while (failures < TWO_FACTOR_MAX_FAILURES) {
      const rid = await createRedirectIntent(TARGET);
      const { body } = await passwordStep(rid);
      for (let i = 0; i < 5 && failures < TWO_FACTOR_MAX_FAILURES; i++, failures++) {
        await codeStep({ challenge: body.challenge, rid, code: '000000' });
      }
    }
    const rid = await createRedirectIntent(TARGET);
    const { body } = await passwordStep(rid);
    expect((await codeStep({ challenge: body.challenge, rid, code: await totp() })).status).toBe(
      429,
    );

    const [row] = await ctx.db
      .select()
      .from(schema.twoFactors)
      .where(eq(schema.twoFactors.userId, user.id));
    expect(row.lockedUntil).not.toBeNull();
  });

  it('forgets the factor on reset', async () => {
    const user = await setup({ twoFactor: true });
    expect(await resetTwoFactor(user.id)).toBe(true);
    const [row] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(row.twoFactorEnabled).toBe(false);
    const { body } = await passwordStep(await createRedirectIntent(TARGET));
    expect(body.needsSecondFactor).toBeUndefined();
  });
});
