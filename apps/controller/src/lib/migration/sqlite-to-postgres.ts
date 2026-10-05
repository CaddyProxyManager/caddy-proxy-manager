/**
 * Copies an install's SQLite database into an empty PostgreSQL one, row for row: ids, secrets
 * (sealed under the same SESSION_SECRET) and the audit hash chain verbatim. Not the legacy
 * importer: this source is a current database, so nothing is re-keyed, nulled or dropped.
 *
 * Independent of the app's own connection, which follows DATABASE_URL: the source and the target
 * are both named by the caller, and nothing here opens a database on import.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as pgSchema from "../db/schema.pg";
import { type Described, describeTables, inFkOrder } from "./tables";

const BATCH_SIZE = 250;

/** Written by the migrations themselves, so an untouched target already holds one row. */
const MIGRATION_SEEDED = new Set(["audit_chain"]);

export class CopyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyRefusedError";
  }
}

export type CopyTableResult = {
  table: string;
  /** Rows in the SQLite source. */
  source: number;
  /** Rows in the target before the copy, migration-seeded rows aside. */
  before: number;
  copied: number;
  /** Rows the target already had under the same key; only with allowNonEmpty. */
  skipped: number;
  /** Rows in the target afterwards; null on a dry run. */
  after: number | null;
};

export type CopyReport = {
  dryRun: boolean;
  /** True when the target had no schema yet: a dry run reports what it would create. */
  targetUnmigrated: boolean;
  tables: CopyTableResult[];
  /** Tables whose counts do not add up, each with why. Empty when the copy is whole. */
  mismatches: string[];
  totalRows: number;
};

export type CopyOptions = {
  sqlitePath: string;
  /** An open Bun SQL client for the target; the caller closes it. */
  target: SQL;
  /** The folder holding `postgres/` and `sqlite/` migrations, as shipped beside the server. */
  migrationsFolder: string;
  dryRun?: boolean;
  /** Copy into a database that already holds rows, skipping any whose key is taken. */
  allowNonEmpty?: boolean;
  log?: (line: string) => void;
};

type Db = ReturnType<typeof drizzle<typeof pgSchema>>;

function journalLength(folder: string): number {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

/** Only a database this version has finished migrating has every column the target expects. */
function assertSourceCurrent(source: Database, migrationsFolder: string): void {
  const expected = journalLength(join(migrationsFolder, "sqlite"));
  let applied = 0;
  try {
    applied =
      source
        .query<{ total: number }, []>("SELECT count(*) AS total FROM __drizzle_migrations")
        .get()?.total ?? 0;
  } catch {
    throw new CopyRefusedError(
      "The source has no migration history: it is not a Caddy Proxy Manager 3.x SQLite database. " +
        "A database from before 3.0 is migrated by the setup screen instead.",
    );
  }
  if (applied !== expected) {
    throw new CopyRefusedError(
      `The SQLite database is at migration ${applied} of ${expected}. Start this version on it ` +
        "once, so it is brought up to date, then stop the server and copy again.",
    );
  }
}

async function targetMigrated(db: Db): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  )) as unknown as Array<{ present: boolean }>;
  return Boolean(rows[0]?.present);
}

async function targetCount(db: Db, table: string): Promise<number> {
  const exists = (await db.execute(
    sql`SELECT to_regclass(${`public."${table}"`}) IS NOT NULL AS present`,
  )) as unknown as Array<{ present: boolean }>;
  if (!exists[0]?.present) return 0;
  const rows = (await db.execute(
    sql`SELECT CAST(count(*) AS integer) AS total FROM ${sql.identifier(table)}`,
  )) as unknown as Array<{ total: number }>;
  return Number(rows[0]?.total ?? 0);
}

function sourceCount(source: Database, table: string): number {
  try {
    return (
      source.query<{ total: number }, []>(`SELECT count(*) AS total FROM "${table}"`).get()
        ?.total ?? 0
    );
  } catch {
    return 0;
  }
}

/** SQLite stores booleans as 0 and 1; everything else is already what PostgreSQL holds. */
function convert(row: Record<string, unknown>, table: Described): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const column of table.columns) {
    if (!(column.name in row)) continue;
    const value = row[column.name];
    converted[column.key] =
      column.isBoolean && (value === 0 || value === 1) ? value === 1 : (value ?? null);
  }
  return converted;
}

export async function copySqliteToPostgres(options: CopyOptions): Promise<CopyReport> {
  const log = options.log ?? (() => {});
  const dryRun = options.dryRun ?? false;
  const source = new Database(options.sqlitePath, { readonly: true });
  const db = drizzle(options.target, { schema: pgSchema });

  try {
    assertSourceCurrent(source, options.migrationsFolder);
    const tables = inFkOrder(describeTables());
    const unmigrated = !(await targetMigrated(db));

    const before = new Map<string, number>();
    for (const table of tables) before.set(table.name, await targetCount(db, table.name));
    const occupied = tables.filter(
      (table) => !MIGRATION_SEEDED.has(table.name) && (before.get(table.name) ?? 0) > 0,
    );
    if (occupied.length > 0 && !options.allowNonEmpty) {
      throw new CopyRefusedError(
        `The PostgreSQL database already holds rows (${occupied
          .map((table) => `${table.name}: ${before.get(table.name)}`)
          .join(", ")}). Copy into an empty database, or pass --allow-non-empty to skip rows ` +
          "whose key is taken.",
      );
    }

    const counts = tables.map((table) => ({ table, source: sourceCount(source, table.name) }));
    if (dryRun) {
      const results = counts.map(({ table, source: rows }) => ({
        table: table.name,
        source: rows,
        before: MIGRATION_SEEDED.has(table.name) ? 0 : (before.get(table.name) ?? 0),
        copied: 0,
        skipped: 0,
        after: null,
      }));
      return {
        dryRun,
        targetUnmigrated: unmigrated,
        tables: results,
        mismatches: [],
        totalRows: results.reduce((sum, result) => sum + result.source, 0),
      };
    }

    if (unmigrated) log("Creating the schema in PostgreSQL");
    await migrate(db, { migrationsFolder: join(options.migrationsFolder, "postgres") });

    const results: CopyTableResult[] = [];
    // One transaction: a failure part-way leaves the target as it was, never half copied.
    await db.transaction(async (tx) => {
      for (const { table, source: rows } of counts) {
        if (MIGRATION_SEEDED.has(table.name)) {
          // The genesis row the migration wrote stands in for the source's head, which replaces it.
          await tx.execute(sql`DELETE FROM ${sql.identifier(table.name)}`);
        }
        let copied = 0;
        const statement = source.query<Record<string, unknown>, [number, number]>(
          `SELECT * FROM "${table.name}" ORDER BY rowid LIMIT ? OFFSET ?`,
        );
        for (let offset = 0; offset < rows; offset += BATCH_SIZE) {
          const batch = statement.all(BATCH_SIZE, offset).map((row) => convert(row, table));
          if (batch.length === 0) break;
          const insert = tx.insert(table.table).values(batch as never);
          const inserted = options.allowNonEmpty
            ? await insert.onConflictDoNothing().returning()
            : await insert.returning();
          copied += inserted.length;
        }
        // Explicit ids leave the sequence behind; is_called false when the table is empty.
        if (table.serialColumn) {
          const column = sql.identifier(table.serialColumn);
          await tx.execute(
            sql`SELECT setval(
                  pg_get_serial_sequence(${`"${table.name}"`}, ${table.serialColumn}),
                  COALESCE((SELECT MAX(${column}) FROM ${sql.identifier(table.name)}), 1),
                  (SELECT MAX(${column}) FROM ${sql.identifier(table.name)}) IS NOT NULL
                )`,
          );
        }
        if (rows > 0) log(`${table.name}: ${copied} of ${rows}`);
        results.push({
          table: table.name,
          source: rows,
          before: MIGRATION_SEEDED.has(table.name) ? 0 : (before.get(table.name) ?? 0),
          copied,
          skipped: rows - copied,
          after: null,
        });
      }
    });

    // Counted again from the committed target, not from what the inserts said they did.
    const mismatches: string[] = [];
    for (const result of results) {
      result.after = await targetCount(db, result.table);
      if (result.after !== result.before + result.copied) {
        mismatches.push(
          `${result.table}: expected ${result.before + result.copied} rows, found ${result.after}`,
        );
      } else if (result.skipped > 0) {
        mismatches.push(`${result.table}: ${result.skipped} rows were already there and skipped`);
      }
    }
    return {
      dryRun,
      targetUnmigrated: unmigrated,
      tables: results,
      mismatches,
      totalRows: results.reduce((sum, result) => sum + result.copied, 0),
    };
  } finally {
    source.close(true);
  }
}
