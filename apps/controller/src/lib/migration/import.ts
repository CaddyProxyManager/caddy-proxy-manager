/**
 * Copies a legacy SQLite database in. Everything derives from the schema, not a list: insert order
 * from its foreign keys, 0/1 to booleans, serial resync (PostgreSQL ignores explicit ids), and
 * references into unselected tables nulled, or the row dropped when it cannot exist without them.
 */
import { Database } from "bun:sqlite";
import type { PgTable } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import db from "../db";
import { reanchorAuditChain } from "../audit/chain";
import { activeSchema, schemaDialect } from "../db/schema";
import * as schema from "../db/schema.pg";
import { type Described, describeTables, inFkOrder } from "./tables";

export { type Described, describeTables, inFkOrder } from "./tables";
import { createRekeyer, LegacySecretError, type Rekeyer } from "./legacy-secrets";
import { sealSecretColumn } from "../secrets";
import { forwardAuthSequentialUserIds } from "../settings/registry";
import { invalidateSettingsCache } from "../settings/resolve";
import {
  ALL_MIGRATION_GROUP_IDS,
  MIGRATION_GROUPS,
  type MigrationGroupId,
  tablesForSelection,
} from "./selection";

const BATCH_SIZE = 250;

export type TableResult = { table: string; copied: number; skipped: number };

export type ImportReport = {
  tables: TableResult[];
  /** Named so nothing looks lost. */
  droppedFromSchema: string[];
  /** Tables the selection left behind, so the summary can say what was deliberately not copied. */
  excludedBySelection: string[];
  /** `table.column`; all provenance (who created or owned a row), never access-granting. */
  clearedReferences: string[];
  totalRows: number;
};

function sqliteTables(source: Database): Set<string> {
  const rows = source
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  return new Set(rows.map((row) => row.name));
}

function sqliteColumns(source: Database, table: string): Set<string> {
  const rows = source.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all();
  return new Set(rows.map((row) => row.name));
}

/**
 * Only booleans differ; coercing anything else risks changing values that were right. `cleared`
 * columns point into tables left behind, which would violate the foreign key.
 */
function convertRow(
  table: string,
  row: Record<string, unknown>,
  columns: Described["columns"],
  available: Set<string>,
  cleared: Set<string>,
  rekey: Rekeyer,
): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const column of columns) {
    if (!available.has(column.name)) continue; // The old schema predates this column.
    if (cleared.has(column.name)) {
      converted[column.name] = null;
      continue;
    }
    const value = row[column.name];
    if (column.isBoolean && (value === 0 || value === 1)) {
      converted[column.name] = value === 1;
      continue;
    }
    // Re-encrypt under this SESSION_SECRET. Every text column: `rekey` keys off the `enc:v1:`
    // marker - which misses the plain-text keys a pre-3.0 database kept.
    converted[column.name] =
      typeof value === "string"
        ? sealSecretColumn(table, column.name, rekey(value))
        : (value ?? null);
  }
  return converted;
}

/**
 * Closes over required references (`api_tokens.createdBy` needs its user) until nothing more
 * falls out, so a new table is handled by its own foreign key rather than a list.
 */
function resolveIncluded(tables: Described[], chosen: Set<string>): Set<string> {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const included = new Set([...chosen].filter((name) => byName.has(name)));

  for (;;) {
    const doomed = [...included].filter((name) =>
      byName
        .get(name)
        ?.references.some(
          (reference) =>
            reference.required && reference.target !== name && !included.has(reference.target),
        ),
    );
    if (doomed.length === 0) return included;
    for (const name of doomed) included.delete(name);
  }
}

/** Columns pointing at something not being migrated. */
function clearedColumns(table: Described, included: Set<string>): Set<string> {
  const cleared = new Set<string>();
  for (const reference of table.references) {
    if (reference.target === table.name || included.has(reference.target)) continue;
    for (const column of reference.columns) cleared.add(column);
  }
  return cleared;
}

/**
 * The destination is expected empty (this runs during setup), so ids are kept and conflicts are
 * skipped, not merged - merging would silently pick a winner.
 */
export async function importLegacyDatabase(
  sqlitePath: string,
  groups: Iterable<MigrationGroupId> = ALL_MIGRATION_GROUP_IDS,
  options: { legacyKey?: string | null } = {},
): Promise<ImportReport> {
  const source = new Database(sqlitePath, { readonly: true });
  const rekey = createRekeyer(options.legacyKey ?? null);

  try {
    const present = sqliteTables(source);
    const described = inFkOrder(describeTables());
    const known = new Set(described.map((table) => table.name));

    // A table no group claims is migrated regardless; the coverage test catches it.
    const chosen = tablesForSelection(groups);
    const claimed = new Set(MIGRATION_GROUPS.flatMap((group) => group.tables));
    for (const table of described) {
      if (!claimed.has(table.name)) chosen.add(table.name);
    }
    const included = resolveIncluded(described, chosen);

    const results: TableResult[] = [];
    const excludedBySelection: string[] = [];
    const clearedReferences: string[] = [];
    let totalRows = 0;

    // Convert everything before writing: a wrong SESSION_SECRET must refuse to start, not stop
    // halfway through a database that must never be retried. Legacy databases fit in memory.
    const prepared: Array<{ table: Described; rows: Array<Record<string, unknown>> }> = [];

    for (const table of described) {
      if (!included.has(table.name)) {
        excludedBySelection.push(table.name);
        continue;
      }

      if (!present.has(table.name)) {
        results.push({ table: table.name, copied: 0, skipped: 0 });
        continue;
      }

      const available = sqliteColumns(source, table.name);
      const cleared = clearedColumns(table, included);
      for (const column of cleared) clearedReferences.push(`${table.name}.${column}`);
      const rows = source.query<Record<string, unknown>, []>(`SELECT * FROM "${table.name}"`).all();

      prepared.push({
        table,
        rows: rows.map((row) => {
          try {
            const converted = convertRow(table.name, row, table.columns, available, cleared, rekey);
            // Mirrors migration 0015: a list from before "Pass auth to host" always forwarded it.
            if (table.name === "access_lists" && !available.has("passAuth")) {
              converted.passAuth = true;
            }
            return converted;
          } catch (error) {
            if (error instanceof LegacySecretError) {
              // The table, not the row: the row's contents are the secret itself.
              throw new LegacySecretError(error.reason, table.name);
            }
            throw error;
          }
        }),
      });
    }

    for (const { table, rows } of prepared) {
      let copied = 0;
      for (let index = 0; index < rows.length; index += BATCH_SIZE) {
        const batch = rows.slice(index, index + BATCH_SIZE);
        if (batch.length === 0) continue;

        // `returning`, since onConflictDoNothing silently drops duplicates.
        const inserted = await db
          .insert(activeSchema[table.key as keyof typeof activeSchema] as PgTable)
          // biome-ignore lint/suspicious/noExplicitAny: the row shape is per-table, and this loop is generic over all thirty
          .values(batch as any)
          .onConflictDoNothing()
          .returning();
        copied += inserted.length;
      }

      // SQLite's AUTOINCREMENT already counts explicit ids.
      if (table.serialColumn && schemaDialect === "postgres") {
        await resyncSequence(table.name, table.serialColumn);
      }

      results.push({ table: table.name, copied, skipped: rows.length - copied });
      totalRows += copied;
    }

    // Pre-3.0 sent the account number as X-CPM-User-Id, and upstreams keyed on it. Migration 0016
    // pins that for upgrades in place, but ran here while `users` was still empty.
    if (results.some((result) => result.table === "users" && result.copied > 0)) {
      await db
        .insert(schema.settings)
        .values({
          key: forwardAuthSequentialUserIds.key,
          value: JSON.stringify(true),
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoNothing();
      invalidateSettingsCache();
    }

    if (results.some((result) => result.table === "audit_events" && result.copied > 0)) {
      await reanchorAuditChain({ adoptUnchained: true });
    }

    return {
      tables: results,
      // Named, so an operator whose old database had waf_events is told they are gone.
      droppedFromSchema: [...present].filter(
        (name) => !known.has(name) && !name.startsWith("sqlite_") && !name.startsWith("__drizzle"),
      ),
      excludedBySelection,
      clearedReferences,
      totalRows,
    };
  } finally {
    source.close(true);
  }
}

/** `setval`'s default third argument (true) means "last value used", as a copied table needs. */
export async function resyncSequence(table: string, column: string): Promise<void> {
  await db.execute(
    sql`SELECT setval(
          pg_get_serial_sequence(${table}, ${column}),
          GREATEST((SELECT COALESCE(MAX(${sql.identifier(column)}), 1) FROM ${sql.identifier(table)}), 1)
        )`,
  );
}
