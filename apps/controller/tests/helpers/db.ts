import { Database } from 'bun:sqlite';
import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { drizzle as drizzleSqlite } from 'drizzle-orm/bun-sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/lib/db/connection';
import * as schema from '../../src/lib/db/schema.pg';
import * as sqliteSchema from '../../src/lib/db/schema.sqlite';

/**
 * `TEST_DB=sqlite` runs the suite against SQLite instead: an in-memory database per test, and no
 * server. Set by `bun run test:sqlite`.
 */
export const testDialect = process.env.TEST_DB === 'sqlite' ? 'sqlite' : 'postgres';

/**
 * Per-test isolation is a PostgreSQL *schema*, not a database: `DROP DATABASE` checkpoints and
 * fsyncs (14.5s for 32, against 0.4s for schemas), and leaked databases exhaust max_connections.
 */
const MIGRATIONS_DIR = resolve(import.meta.dir, '../../drizzle', testDialect);

/** Set by scripts/with-test-db.ts; bare `bun test` has no server and cannot work. */
function adminUrl(): string {
  const url = process.env.TEST_POSTGRES_URL;
  if (!url) {
    throw new Error(
      'TEST_POSTGRES_URL is not set. Run the suite with `bun run test`, which starts a throwaway ' +
        'PostgreSQL container, or set TEST_POSTGRES_URL to a server of your own.',
    );
  }
  return url;
}

/**
 * Every migration, in the order drizzle's journal records, so a test schema is built exactly the
 * way a deployment is.
 */
function migrationSql(part: 'all' | 'before' | 'from' = 'all', tagSuffix = ''): string {
  const journal = JSON.parse(
    readFileSync(resolve(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = [...journal.entries].sort((left, right) => left.idx - right.idx);
  const split =
    part === 'all' ? entries.length : entries.findIndex((entry) => entry.tag.endsWith(tagSuffix));
  if (split < 0) throw new Error(`No migration tagged *${tagSuffix}`);
  return (part === 'from' ? entries.slice(split) : entries.slice(0, split))
    .map((entry) => readFileSync(resolve(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf8'))
    .join('\n');
}

/**
 * The DDL, rewritten to build inside one schema. drizzle-kit emits its foreign keys as
 * `REFERENCES "public"."users"`, which would point every schema's tables back at public.
 */
function ddlFor(schemaName: string, migrations = migrationSql()): string {
  const raw = migrations.split('--> statement-breakpoint').join('\n');
  const scoped = raw.replaceAll('"public".', `"${schemaName}".`);
  // Guard against drizzle changing how it qualifies names: an unrewritten reference would silently
  // wire this schema's foreign keys to another test's tables.
  if (scoped.includes('"public"')) {
    throw new Error('Migration SQL still references "public" after rewriting; update ddlFor().');
  }
  return scoped;
}

/** Typed as the app's `Db` so tests can use tables from src/lib/db/schema on the handle. */
export type TestDb = Db;

type Live = { sql: SQL; schemaName: string } | { sqlite: Database };

const live: Live[] = [];
let adminPool: SQL | undefined;

/**
 * Where the current test's schemas start in `live`. Earlier ones were created at import by files
 * that build one database for the whole file; dropping them would break the rest of it.
 */
let testBoundary = 0;

function admin(): SQL {
  adminPool ??= new SQL({ url: adminUrl(), max: 4 });
  return adminPool;
}

/**
 * A fresh, fully migrated PostgreSQL schema. `max: 1` because `search_path` is per connection -
 * a pool would hand later queries a connection still pointed at public.
 */
export async function createTestDb(): Promise<TestDb> {
  if (testDialect === 'sqlite') {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON');
    sqlite.run(migrationSql().split('--> statement-breakpoint').join('\n'));
    live.push({ sqlite });
    return drizzleSqlite(sqlite, { schema: sqliteSchema }) as unknown as TestDb;
  }

  const schemaName = `t_${randomUUID().replaceAll('-', '')}`;
  await admin().unsafe(`CREATE SCHEMA "${schemaName}"`);

  const sql = new SQL({ url: adminUrl(), max: 1 });
  await sql.unsafe(`SET search_path TO "${schemaName}"; ${ddlFor(schemaName)}`);

  live.push({ sql, schemaName });
  return drizzle(sql, { schema }) as unknown as TestDb;
}

/**
 * Migrated up to the first migration tagged `*tagSuffix` (the same suffix in both dialects), so a
 * test can seed the state that migration meets with raw `exec` (the schema already names columns
 * it adds), then run it and the rest with `migrateRest`.
 */
export async function createTestDbBefore(tagSuffix: string): Promise<{
  db: TestDb;
  exec: (statement: string) => Promise<void>;
  migrateRest: () => Promise<void>;
}> {
  const before = migrationSql('before', tagSuffix);
  const rest = migrationSql('from', tagSuffix);
  if (testDialect === 'sqlite') {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON');
    sqlite.run(before.split('--> statement-breakpoint').join('\n'));
    live.push({ sqlite });
    return {
      db: drizzleSqlite(sqlite, { schema: sqliteSchema }) as unknown as TestDb,
      exec: async (statement) => {
        sqlite.run(statement);
      },
      migrateRest: async () => {
        sqlite.run(rest.split('--> statement-breakpoint').join('\n'));
      },
    };
  }

  const schemaName = `t_${randomUUID().replaceAll('-', '')}`;
  await admin().unsafe(`CREATE SCHEMA "${schemaName}"`);
  const sql = new SQL({ url: adminUrl(), max: 1 });
  await sql.unsafe(`SET search_path TO "${schemaName}"; ${ddlFor(schemaName, before)}`);
  live.push({ sql, schemaName });
  return {
    db: drizzle(sql, { schema }) as unknown as TestDb,
    exec: async (statement) => {
      await sql.unsafe(statement);
    },
    migrateRest: async () => {
      await sql.unsafe(ddlFor(schemaName, rest));
    },
  };
}

/**
 * A fresh, empty PostgreSQL *database*, for tests that boot the real src/lib/db module (it reads
 * DATABASE_URL itself). Unmigrated: a caller seeding a pre-migration state runs them itself.
 */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (testDialect === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'cpm-test-'));
    return {
      url: `file:${join(directory, 'cpm.db')}`,
      drop: async () => {
        // Windows refuses to delete a file a handle still holds; the OS reaps its temp dir anyway.
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {}
      },
    };
  }

  const name = `d_${randomUUID().replaceAll('-', '')}`;
  await admin().unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    // Slow (DROP DATABASE fsyncs), so not in the schema afterEach; the throwaway server dies with
    // the run.
    drop: async () => {
      await admin().unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}

/** Records that anything created from here on belongs to one test. Called from a beforeEach. */
export function markTestBoundary(): void {
  testBoundary = live.length;
}

/** Closes every handle the current test opened and drops its schemas. Called from an afterEach. */
export async function cleanupTestDbs(): Promise<void> {
  const pending = live.splice(testBoundary, live.length - testBoundary);
  if (pending.length === 0) return;

  for (const entry of pending) {
    if ('sqlite' in entry) entry.sqlite.close(true);
  }
  const schemas = pending.filter((entry) => 'sql' in entry);
  await Promise.all(schemas.map(({ sql }) => sql.close()));
  await Promise.all(
    schemas.map(({ schemaName }) => admin().unsafe(`DROP SCHEMA "${schemaName}" CASCADE`)),
  );
}

/**
 * Stand-in for the `db` module's default export. Bun evaluates a mock factory's getters once at
 * link time, so `get default() { return db }` would capture `undefined`; this resolves each read
 * against `current()` and binds methods so drizzle sees the right `this`.
 */
export function currentDb(current: () => TestDb): TestDb {
  return new Proxy({} as TestDb, {
    get(_target, property) {
      const db = current() as unknown as Record<string | symbol, unknown>;
      const value = db[property];
      return typeof value === 'function' ? value.bind(db) : value;
    },
    has(_target, property) {
      return property in (current() as unknown as object);
    },
  });
}
