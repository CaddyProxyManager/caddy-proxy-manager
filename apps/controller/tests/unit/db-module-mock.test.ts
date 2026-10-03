/**
 * dbModuleMock stands in for all of src/lib/db: a name it lacks would fall through to the real
 * module and its connection (see tests/helpers/db-module.ts).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Glob } from 'bun';
import { eq } from 'drizzle-orm';
import * as realDbModule from '../../src/lib/db';
import { users } from '../../src/lib/db/schema';
import { createTestDb } from '../helpers/db';
import { dbModuleMock } from '../helpers/db-module';

const NOW = new Date().toISOString();

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
    for (const file of new Glob('**/*.test.{ts,tsx}').scanSync(resolve(import.meta.dir, '..'))) {
      const source = readFileSync(resolve(import.meta.dir, '..', file), 'utf8');
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
    const db = await createTestDb();
    const { runInTransaction } = dbModuleMock(() => db);
    await runInTransaction((tx) => [
      tx.insert(users).values({ email: 'a@example.com', createdAt: NOW, updatedAt: NOW }),
    ]);
    expect(await db.select().from(users).where(eq(users.email, 'a@example.com'))).toHaveLength(1);
  });

  it('rolls the whole batch back when a statement fails', async () => {
    const db = await createTestDb();
    const { runInTransaction } = dbModuleMock(() => db);
    await expect(
      runInTransaction((tx) => [
        tx.insert(users).values({ email: 'b@example.com', createdAt: NOW, updatedAt: NOW }),
        tx.insert(users).values({ email: 'b@example.com', createdAt: NOW, updatedAt: NOW }),
      ]),
    ).rejects.toThrow();
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('follows the database the getter returns now', async () => {
    let db = await createTestDb();
    const mock = dbModuleMock(() => db);
    db = await createTestDb();
    await db.insert(users).values({ email: 'c@example.com', createdAt: NOW, updatedAt: NOW });
    expect(await mock.default.select().from(users)).toHaveLength(1);
  });
});
