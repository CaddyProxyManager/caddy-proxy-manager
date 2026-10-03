/**
 * A passkey outlives the directory sign-in it was registered after, so a directory that was a
 * user's only way in takes the passkeys and sessions with it when deleted, and stops them while
 * disabled.
 */
import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import {
  deleteLdapDirectory,
  directoryAccessWithdrawn,
  setLdapDirectoryEnabled,
} from '@/src/lib/models/ldap-directories';
import { accounts, oauthProviders, passkeys, sessions, users } from '../../src/lib/db/schema';

const NOW = new Date().toISOString();
let seq = 0;

async function directory(enabled = true, type = 'ldap'): Promise<string> {
  const id = `provider-${++seq}`;
  await ctx.db.insert(oauthProviders).values({
    id,
    name: id,
    type,
    clientId: '',
    clientSecret: '',
    enabled,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function user(providerIds: string[], passwordHash: string | null = null): Promise<number> {
  const n = ++seq;
  const [row] = await ctx.db
    .insert(users)
    .values({ email: `u${n}@example.com`, passwordHash, createdAt: NOW, updatedAt: NOW })
    .returning({ id: users.id });
  for (const providerId of providerIds) {
    await ctx.db.insert(accounts).values({
      userId: row.id,
      providerId,
      accountId: `${providerId}-${n}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  await ctx.db.insert(passkeys).values({
    userId: row.id,
    publicKey: 'cose',
    credentialID: `credential-${n}`,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    createdAt: NOW,
  });
  await ctx.db.insert(sessions).values({
    userId: row.id,
    token: `session-${n}`,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return row.id;
}

const countOf = async (table: typeof passkeys | typeof sessions, userId: number) =>
  (await ctx.db.select().from(table).where(eq(table.userId, userId))).length;

describe('directoryAccessWithdrawn', () => {
  it('holds only when every way in is a directory and none is enabled', async () => {
    const on = await directory(true);
    const off = await directory(false);
    const oidc = await directory(true, 'oidc');

    expect(await directoryAccessWithdrawn(await user([on]))).toBe(false);
    expect(await directoryAccessWithdrawn(await user([off]))).toBe(true);
    expect(await directoryAccessWithdrawn(await user([off, on]))).toBe(false);
    expect(await directoryAccessWithdrawn(await user([off, oidc]))).toBe(false);
    expect(await directoryAccessWithdrawn(await user([off, 'credential']))).toBe(false);
    expect(await directoryAccessWithdrawn(await user([off], 'hash'))).toBe(false);
    // Not a directory user at all.
    expect(await directoryAccessWithdrawn(await user([]))).toBe(false);
    expect(await directoryAccessWithdrawn(await user([on]), on)).toBe(true);
  });
});

describe('disabling and deleting a directory', () => {
  it('leaves passkeys alone on disable, so enabling it again restores them', async () => {
    const id = await directory(true);
    const member = await user([id]);

    await setLdapDirectoryEnabled(id, false);

    expect(await countOf(passkeys, member)).toBe(1);
    expect(await directoryAccessWithdrawn(member)).toBe(true);
    await setLdapDirectoryEnabled(id, true);
    expect(await directoryAccessWithdrawn(member)).toBe(false);
  });

  it('removes the passkeys and sessions of the users it was the only way in for', async () => {
    const id = await directory(true);
    const other = await directory(true);
    const stranded = await user([id]);
    const withPassword = await user([id], 'hash');
    const inTwo = await user([id, other]);

    await deleteLdapDirectory(id);

    expect(await countOf(passkeys, stranded)).toBe(0);
    expect(await countOf(sessions, stranded)).toBe(0);
    for (const kept of [withPassword, inTwo]) {
      expect(await countOf(passkeys, kept)).toBe(1);
      expect(await countOf(sessions, kept)).toBe(1);
    }
  });
});
