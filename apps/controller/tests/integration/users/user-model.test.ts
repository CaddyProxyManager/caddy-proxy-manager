/**
 * The corners of the user model the sign-in-name and password suites leave: lookups, the email
 * and chosen-username checks at creation, and self-registration's username.
 */
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
  applySignInNameRules,
  createUser,
  findUserByEmail,
  getUserCount,
  listUsers,
} from '@/src/lib/models/user';
import { DomainError } from '@/src/lib/errors/domain-error';
import { accounts, users } from '../../../src/lib/db/schema';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
}

function create(email: string, extra: Partial<Parameters<typeof createUser>[0]> = {}) {
  return createUser({ email, provider: 'credentials', subject: email, ...extra });
}

beforeEach(async () => {
  await ctx.db.delete(accounts);
  await ctx.db.delete(users);
});

describe('lookups', () => {
  it('counts users and finds one by email, whatever its case or padding', async () => {
    expect(await getUserCount()).toBe(0);
    const alice = await create('alice@example.com');
    await create('bob@example.com');

    expect(await getUserCount()).toBe(2);
    expect((await findUserByEmail('  ALICE@Example.com '))?.id).toBe(alice.id);
    expect(await findUserByEmail('nobody@example.com')).toBeNull();
    expect((await listUsers()).map((user) => user.email)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
  });
});

describe('createUser', () => {
  it("stores Better Auth's provider name as CPM's, with the credential account", async () => {
    const user = await create('alice@example.com', {
      provider: 'credential',
      passwordHash: 'hash',
    });

    expect(user.provider).toBe('credentials');
    const rows = await ctx.db.select().from(accounts).where(eq(accounts.userId, user.id));
    expect(rows).toEqual([expect.objectContaining({ providerId: 'credential', password: 'hash' })]);
  });

  it('refuses a blank email, and one that lowercases into another address', async () => {
    expect(await codeOf(create('   '))).toBe('emailRequired');
    // KELVIN SIGN lowercases to an ASCII "k".
    expect(await codeOf(create(`${String.fromCodePoint(0x212a)}im@example.com`))).toBe(
      'emailLowercasesIntoAscii',
    );
    expect(await getUserCount()).toBe(0);
  });

  it("takes an administrator's chosen username, trimmed, and refuses a bad or taken one", async () => {
    const alice = await create('alice@example.com', { username: '  alice.ops ' });
    expect(alice.username).toBe('alice.ops');

    expect(await codeOf(create('bob@example.com', { username: 'Bob' }))).toBe(
      'signInUsernameInvalid',
    );
    expect(await codeOf(create('bob@example.com', { username: 'alice.ops' }))).toBe(
      'signInNameTaken',
    );
    expect(await getUserCount()).toBe(1);
  });
});

describe('applySignInNameRules', () => {
  it('gives a self-registered account its own email as username', async () => {
    const shaped = await applySignInNameRules({ email: 'carol@example.com', name: 'Carol' }, true);
    expect(shaped).toMatchObject({
      username: 'carol@example.com',
      displayUsername: 'carol@example.com',
    });
  });

  it('refuses an address somebody already has', async () => {
    await create('carol@example.com');
    expect(await codeOf(applySignInNameRules({ email: 'Carol@example.com' }, true))).toBe(
      'emailTaken',
    );
  });
});
