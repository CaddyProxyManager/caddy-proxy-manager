/**
 * The driver and its migrations; the one place allowed to know the dialect. `db` is typed as
 * PostgreSQL either way, so a SQLite-only call fails typecheck rather than in production.
 */
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { drizzle as drizzlePg, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { migrate as migratePg } from "drizzle-orm/bun-sql/migrator";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { migrate as migrateSqlite } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { type DatabaseDialect, driverOptions, resolveDatabaseTarget } from "./dialect";
import { activeSchema, schemaDialect } from "./schema";
import { restrictDatabaseFileModes, vacuumDeletedContent } from "./sqlite-hygiene";
import * as pgSchema from "./schema.pg";

export type Db = BunSQLDatabase<typeof pgSchema> & { $client: unknown };

type GlobalForDrizzle = typeof globalThis & {
  __DRIZZLE_DB__?: Db;
  __DB_CLIENT__?: SQL | Database;
  __MIGRATIONS_RAN__?: boolean;
};

const globalForDrizzle = globalThis as GlobalForDrizzle;

export const target = resolveDatabaseTarget(process.env);
export const dialect: DatabaseDialect = target.kind === "sqlite" ? "sqlite" : "postgres";

// A PostgreSQL driver handed SQLite tables fails far from the cause ("column is of type boolean").
if (schemaDialect !== dialect) {
  throw new Error(`The ${schemaDialect} schema was loaded for a ${dialect} connection.`);
}

/**
 * Bun.SQL's undocumented default; 30 concurrent queries run in three batches. An env var, not a
 * setting: the pool must exist before the database can be read. SQLite ignores it.
 */
const DEFAULT_POOL_MAX = 10;
const poolMax = Number(process.env.DATABASE_POOL_MAX) || DEFAULT_POOL_MAX;

function openSqlite(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  // Off by default in SQLite, and every ON DELETE in the schema depends on it.
  database.run("PRAGMA foreign_keys = ON");
  // Readers stop blocking the writer; a second writer waits rather than failing at once.
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA busy_timeout = 5000");
  // Zeroes deleted and replaced content instead of leaving it in free pages, where a secret
  // re-encrypted or removed after the fact could be read back from the file or a copy of it.
  database.run("PRAGMA secure_delete = ON");
  // After the pragmas, so the WAL files exist to be covered too.
  restrictDatabaseFileModes(path);
  return database;
}

/** SQLite only; see ./sqlite-hygiene.ts. `force` after a startup pass rewrote secrets. */
export function purgeDeletedDatabaseContent(force = false): boolean {
  if (!(client instanceof Database) || target.kind !== "sqlite" || target.path === ":memory:") {
    return false;
  }
  return vacuumDeletedContent(client, force);
}

/**
 * Only the migration path should need the raw handle. Options are spread as fields, so a password
 * with `/` or `@` is not read as a URL delimiter (./dialect.ts).
 */
export const client: SQL | Database =
  globalForDrizzle.__DB_CLIENT__ ??
  (target.kind === "sqlite"
    ? openSqlite(target.path)
    : new SQL({ ...driverOptions(target), max: poolMax }));

export const db: Db =
  globalForDrizzle.__DRIZZLE_DB__ ??
  ((client instanceof Database
    ? drizzleSqlite(client, { schema: activeSchema as never })
    : drizzlePg(client, { schema: pgSchema })) as unknown as Db);

// Dev-mode module reloads would otherwise open a new connection per edit.
if (process.env.NODE_ENV !== "production") {
  globalForDrizzle.__DB_CLIENT__ = client;
  globalForDrizzle.__DRIZZLE_DB__ = db;
}

const migrationsFolder = resolvePath(process.cwd(), "drizzle", dialect);

/** True for the "table already exists" race between parallel Next build workers. */
function isAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("message" in error)) return false;
  const message = (error as { message: unknown }).message;
  const code = "code" in error ? (error as { code: unknown }).code : undefined;
  // By code, not message text, which real migration failures can share. 42P07 duplicate_table,
  // 42P06 duplicate_schema.
  return (
    code === "42P07" ||
    code === "42P06" ||
    (code === "SQLITE_ERROR" && typeof message === "string" && message.includes("already exists"))
  );
}

/**
 * Refuse a pre-3.0 SQLite file: history restarts at 0000, and the build-race handler would
 * swallow its "already exists". Ours has its baseline row in __drizzle_migrations.
 */
function assertNotLegacySqlite(database: Database): void {
  const hasTables = database
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get();
  if (!hasTables) return;

  const journal = JSON.parse(
    readFileSync(resolvePath(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ when: number }> };
  const baseline = journal.entries[0]?.when;
  let ours = false;
  try {
    ours = !!database
      .query("SELECT 1 FROM __drizzle_migrations WHERE created_at = ?")
      .get(baseline ?? -1);
  } catch {
    // No migrations table: not ours either.
  }
  if (!ours) {
    throw new Error(
      "DATABASE_URL points at a SQLite database from before 3.0, which this version cannot run " +
        "on directly. Point DATABASE_URL at a new file (file:/app/data/cpm.db) or at PostgreSQL " +
        "and start the app: it finds the old database and offers to migrate it.",
    );
  }
}

export async function runSchemaMigrations(): Promise<void> {
  if (globalForDrizzle.__MIGRATIONS_RAN__) {
    return;
  }

  if (client instanceof Database) {
    assertNotLegacySqlite(client);
  }

  try {
    if (dialect === "sqlite") {
      migrateSqlite(db as unknown as Parameters<typeof migrateSqlite>[0], { migrationsFolder });
    } else {
      await migratePg(db as unknown as Parameters<typeof migratePg>[0], { migrationsFolder });
    }
    globalForDrizzle.__MIGRATIONS_RAN__ = true;
  } catch (error: unknown) {
    // Parallel prerendering during the build races the migrations.
    if (isAlreadyExistsError(error)) {
      console.log("Database tables already exist, skipping migrations");
      globalForDrizzle.__MIGRATIONS_RAN__ = true;
      return;
    }
    throw error;
  }
}

/** `:memory:` or the test harness's opt-in: nothing for ../db.ts's data migrations to do. */
export const isEphemeral =
  process.env.CPM_EPHEMERAL_DB === "true" ||
  (target.kind === "sqlite" && target.path === ":memory:");

/** Awaited under PostgreSQL, `.run()` under SQLite. */
// biome-ignore lint/suspicious/noExplicitAny: builder types are per-dialect and per-table
type Executable = PromiseLike<any> & { run?: () => unknown };

/**
 * The callback returns statements, not runs them: bun:sqlite commits when its synchronous
 * callback returns, so an async body would commit before its first `await`.
 */
export async function runInTransaction(
  // biome-ignore lint/suspicious/noExplicitAny: `tx` is the per-dialect transaction handle
  build: (tx: any) => Executable[],
): Promise<void> {
  if (dialect === "sqlite") {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    (db as any).transaction((tx: any) => {
      for (const statement of build(tx)) {
        statement.run?.();
      }
    });
    return;
  }

  // biome-ignore lint/suspicious/noExplicitAny: see above
  await (db as any).transaction(async (tx: any) => {
    for (const statement of build(tx)) {
      await statement;
    }
  });
}
