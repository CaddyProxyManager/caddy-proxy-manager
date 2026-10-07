/** The users list's account source and last sign-in, read from what sign-in records. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import {
  passwordSignInMethod,
  recordSignIn,
  sessionSignInMethod,
} from '@/src/lib/auth/last-sign-in';
import { accountSourcesByUser, linkedAccountCounts } from '@/src/lib/users/account-source';
import { accounts, oauthProviders, users } from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();

async function seedUser(email: string, passwordHash: string | null = null): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({ email, passwordHash, role: 'user', createdAt: NOW, updatedAt: NOW })
    .returning({ id: users.id });
  return row.id;
}

async function link(userId: number, providerId: string) {
  await ctx.db.insert(accounts).values({
    userId,
    accountId: `${providerId}-${userId}`,
    providerId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedProvider(id: string, type: string) {
  await ctx.db.insert(oauthProviders).values({
    id,
    name: id,
    type,
    clientId: 'x',
    clientSecret: 'x',
    autoLink: false,
    enabled: true,
    source: 'ui',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

let local: number;
let directory: number;
let sso: number;

beforeEach(async () => {
  await ctx.db.delete(accounts);
  await ctx.db.delete(users);
  await ctx.db.delete(oauthProviders);
  await seedProvider('corp-ldap', 'ldap');
  await seedProvider('idp', 'oidc');
  local = await seedUser('local@example.com', 'hash');
  await link(local, 'idp');
  directory = await seedUser('dir@example.com');
  await link(directory, 'corp-ldap');
  sso = await seedUser('sso@example.com');
  await link(sso, 'idp');
});

describe('account sources', () => {
  it('is local with a password, else the directory or provider the account came from', async () => {
    const sources = await accountSourcesByUser();
    expect(sources.get(local)).toBe('local');
    expect(sources.get(directory)).toBe('ldap');
    expect(sources.get(sso)).toBe('oidc');
    expect((await linkedAccountCounts()).get('idp')).toBe(2);
  });
});

describe('the sign-in method', () => {
  it('names a passkey, single sign-on, and the password behind a second factor', async () => {
    expect(await sessionSignInMethod(local, '/passkey/verify-authentication')).toBe('passkey');
    expect(await sessionSignInMethod(sso, '/oauth2/callback/:providerId')).toBe('oidc');
    expect(await sessionSignInMethod(sso, '/sso/saml2/sp/acs/:providerId')).toBe('oidc');
    expect(await sessionSignInMethod(local, '/two-factor/verify-totp')).toBe('password');
    expect(await sessionSignInMethod(directory, '/two-factor/verify-totp')).toBe('ldap');
    // Recorded by the auth route instead, once the second step is known not to follow.
    expect(await sessionSignInMethod(local, '/sign-in/username')).toBeNull();
  });

  it('tells a directory password from a local one typed into the same form', async () => {
    expect(await passwordSignInMethod(local, '/sign-in/username', false)).toBe('password');
    expect(await passwordSignInMethod(local, '/sign-in/ldap', false)).toBe('password');
    expect(await passwordSignInMethod(local, '/sign-in/ldap', true)).toBe('ldap');
    expect(await passwordSignInMethod(directory, '/sign-in/ldap', false)).toBe('ldap');
  });

  it('is stored with the time', async () => {
    await recordSignIn(sso, 'oidc');
    const [row] = await ctx.db.select().from(users).where(eq(users.id, sso));
    expect(row.lastSignInMethod).toBe('oidc');
    expect(row.lastSignInAt).toBeTruthy();
  });
});
