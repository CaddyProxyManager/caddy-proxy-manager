/**
 * What only a real file exercises: the migrator, the pragmas the schema assumes, and refusing a
 * pre-3.0 file an old .env still points at. `test:sqlite` covers the models.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadDbModule } from '@/tests/helpers/fresh-db';

const NOW = '2026-01-01T00:00:00.000Z';

let directory: string;
const opened: Database[] = [];

function resetDbModuleState() {
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  delete globals.__DRIZZLE_DB__;
  delete globals.__DB_CLIENT__;
  delete globals.__MIGRATIONS_RAN__;
}

async function boot(file: string) {
  process.env.DATABASE_URL = `file:${file}`;
  resetDbModuleState();
  const reloaded = await reloadDbModule();
  opened.push(reloaded.dbModule.client as Database);
  return reloaded;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cpm-sqlite-'));
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close(true);
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  resetDbModuleState();
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {}
});

describe('SQLite backend', () => {
  it('creates and migrates a new file, then reopens it without migrating twice', async () => {
    const file = join(directory, 'nested', 'cpm.db');
    const first = await boot(file);
    expect(first.schema.schemaDialect).toBe('sqlite');

    const { default: db, nowIso } = first.dbModule;
    const { users } = first.schema;
    await db.insert(users).values({
      email: 'a@localhost',
      emailVerified: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    opened.pop()?.close(true);

    const second = await boot(file);
    const [row] = await second.dbModule.default
      .select()
      .from(second.schema.users)
      .where(eq(second.schema.users.email, 'a@localhost'));
    // A real boolean back, not SQLite's 1.
    expect(row.emailVerified).toBe(true);
  });

  it('enforces foreign keys, so ON DELETE cascades as it does on PostgreSQL', async () => {
    const { dbModule, schema } = await boot(join(directory, 'cpm.db'));
    const db = dbModule.default;
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'b@localhost', createdAt: NOW, updatedAt: NOW })
      .returning();
    await db.insert(schema.sessions).values({
      userId: user.id,
      token: 'token',
      expiresAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await db.delete(schema.users).where(eq(schema.users.id, user.id));
    expect(await db.select().from(schema.sessions)).toHaveLength(0);
  });

  it('runs a transaction as one unit, rolling back every statement when one fails', async () => {
    const { dbModule, schema } = await boot(join(directory, 'cpm.db'));
    const { default: db, runInTransaction } = dbModule;

    await runInTransaction((tx) => [
      tx.insert(schema.settings).values({ key: 'a', value: '1', updatedAt: NOW }),
      tx.insert(schema.settings).values({ key: 'b', value: '2', updatedAt: NOW }),
    ]);
    expect(await db.select().from(schema.settings)).toHaveLength(2);

    await expect(
      runInTransaction((tx) => [
        tx.insert(schema.settings).values({ key: 'c', value: '3', updatedAt: NOW }),
        tx.insert(schema.settings).values({ key: 'a', value: 'duplicate', updatedAt: NOW }),
      ]),
    ).rejects.toThrow();
    expect(await db.select().from(schema.settings)).toHaveLength(2);
  });

  it('refuses a pre-3.0 database rather than migrating over it', async () => {
    const file = join(directory, 'caddy-proxy-manager.db');
    const legacy = new Database(file);
    migrate(drizzle(legacy), {
      migrationsFolder: resolve(process.cwd(), 'drizzle', 'legacy-sqlite'),
    });
    legacy.close(true);

    await expect(boot(file)).rejects.toThrow(/from before 3\.0/);
  });
});
