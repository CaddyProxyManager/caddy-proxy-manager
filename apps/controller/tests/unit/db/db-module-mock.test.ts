/**
 * dbModuleMock stands in for all of src/lib/db: a name it lacks would fall through to the real
 * module and its connection (see tests/helpers/db-module.ts).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Glob } from 'bun';
import { eq } from 'drizzle-orm';
import * as realDbModule from '../../../src/lib/db';
import { users } from '../../../src/lib/db/schema';
import { createTestDb, type TestDb } from '../../helpers/db';
import { dbModuleMock } from '../../helpers/db-module';

const NOW = new Date().toISOString();

// One schema for the file, made at import so the per-test cleanup keeps it: each costs a full
// migration, which is what made this file slow under a parallel run. Tests use their own emails.
const shared = await createTestDb();
const byEmail = (email: string) => shared.select().from(users).where(eq(users.email, email));

describe('dbModuleMock', () => {
  it('provides every export of src/lib/db', () => {
    const mock = dbModuleMock(() => {
      throw new Error('not read');
    });
    expect(Object.keys(mock).sort()).toEqual(Object.keys(realDbModule).sort());
  });

  it('is how every test mocks src/lib/db', () => {
    const inline: string[] = [];
    let sites = 0;
    for (const file of new Glob('**/*.test.{ts,tsx}').scanSync(resolve(import.meta.dir, '../..'))) {
      const source = readFileSync(resolve(import.meta.dir, '../..', file), 'utf8');
      for (const [, factory] of source.matchAll(/vi\.mock\(\s*'[^']*src\/lib\/db',\s*([^\n]*)/g)) {
        sites++;
        if (!factory.startsWith('() => dbModuleMock(')) inline.push(file);
      }
    }
    expect(inline).toEqual([]);
    // Guards the pattern itself: one that matched nothing would pass.
    expect(sites).toBeGreaterThan(100);
  });

  it('runs a transaction on the database it was given', async () => {
    const { runInTransaction } = dbModuleMock(() => shared);
    await runInTransaction((tx) => [
      tx.insert(users).values({ email: 'a@example.com', createdAt: NOW, updatedAt: NOW }),
    ]);
    expect(await byEmail('a@example.com')).toHaveLength(1);
  });

  it('rolls the whole batch back when a statement fails', async () => {
    const { runInTransaction } = dbModuleMock(() => shared);
    await expect(
      runInTransaction((tx) => [
        tx.insert(users).values({ email: 'b@example.com', createdAt: NOW, updatedAt: NOW }),
        tx.insert(users).values({ email: 'b@example.com', createdAt: NOW, updatedAt: NOW }),
      ]),
    ).rejects.toThrow();
    expect(await byEmail('b@example.com')).toHaveLength(0);
  });

  it('follows the database the getter returns now', async () => {
    // Never queried: reading it would throw rather than find the row.
    let db = {} as TestDb;
    const mock = dbModuleMock(() => db);
    db = shared;
    await db.insert(users).values({ email: 'c@example.com', createdAt: NOW, updatedAt: NOW });
    expect(
      await mock.default.select().from(users).where(eq(users.email, 'c@example.com')),
    ).toHaveLength(1);
  });
});
