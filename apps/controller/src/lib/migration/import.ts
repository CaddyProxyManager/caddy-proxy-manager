/**
 * Copying a vetted legacy SQLite database into the current database, PostgreSQL or SQLite.
 *
 * Four things make this more than a row-for-row copy, and all four are derived from the schema
 * rather than from a list someone has to keep in step with it:
 *
 * 1. **Order.** Foreign keys mean `accounts` cannot land before `users`. The order is a
 *    topological sort of the schema's own foreign keys, so adding a table with a new reference
 *    orders itself.
 * 2. **Booleans.** SQLite stored them as 0/1 and PostgreSQL will not accept an integer in a
 *    boolean column. The columns that need converting are read off the drizzle schema.
 * 3. **Sequences.** Rows keep their ids so foreign keys stay intact, and PostgreSQL does not
 *    advance a `serial` for an explicit id - so every sequence is resynced afterwards. Skipping
 *    this is the bug that made the first post-migration insert fail with a duplicate key.
 * 4. **Selection.** An operator can leave a group behind - most usefully the old accounts. A
 *    table nobody chose is not copied, and the references into it are resolved from the foreign
 *    keys too: a nullable one is nulled, and a table that cannot exist without its parent is
 *    dropped along with it. Neither decision is a list, so a new table gets them for free.
 */
import { Database } from "bun:sqlite";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is, sql } from "drizzle-orm";
import db from "../db";
import { activeSchema, schemaDialect } from "../db/schema";
import * as schema from "../db/schema.pg";
import { createRekeyer, LegacySecretError, type Rekeyer } from "./legacy-secrets";
import { sealSecretColumn } from "../secret";
import {
  ALL_MIGRATION_GROUP_IDS,
  MIGRATION_GROUPS,
  type MigrationGroupId,
  tablesForSelection,
} from "./selection";

/** How many rows to insert per statement. Large enough to be fast, small enough to stay readable. */
const BATCH_SIZE = 250;

export type TableResult = { table: string; copied: number; skipped: number };

export type ImportReport = {
  tables: TableResult[];
  /** Tables the old database had that this version no longer has, named so nothing looks lost. */
  droppedFromSchema: string[];
  /** Tables the selection left behind, so the summary can say what was deliberately not copied. */
  excludedBySelection: string[];
  /**
   * Columns emptied because what they pointed at was not migrated, as `table.column`. All of them
   * are provenance - who created a row, who owned it - never something that grants access.
   */
  clearedReferences: string[];
  totalRows: number;
};

type Reference = {
  /** The table pointed at. */
  target: string;
  /** The local columns holding the reference. */
  columns: string[];
  /** True when the row cannot exist at all without its target. */
  required: boolean;
};

export type Described = {
  key: string;
  /** Read for its shape only; rows are written to the active backend's table of the same key. */
  table: PgTable;
  name: string;
  columns: Array<{ name: string; isBoolean: boolean }>;
  references: Reference[];
  /** The serial column whose sequence needs resyncing, if the table has one. */
  serialColumn: string | null;
};

export function describeTables(): Described[] {
  const described: Described[] = [];

  for (const [key, value] of Object.entries(schema)) {
    // The schema module also exports types and helpers. `is` is the only reliable runtime test:
    // `$inferSelect` is a type-only phantom and is not present on the object at all.
    if (!is(value, PgTable)) continue;
    const table = value as PgTable;

    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(table);
    } catch {
      continue;
    }

    described.push({
      key,
      table,
      name: config.name,
      columns: config.columns.map((column) => ({
        name: column.name,
        isBoolean: column.dataType === "boolean",
      })),
      references: config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          target: getTableConfig(reference.foreignTable).name,
          columns: reference.columns.map((column) => column.name),
          // One non-null column is enough: the row has nowhere to put "no parent".
          required: reference.columns.some((column) => column.notNull),
        };
      }),
      serialColumn: config.columns.find((column) => column.columnType === "PgSerial")?.name ?? null,
    });
  }

  return described;
}

/**
 * Tables ordered so every reference is satisfied before the table that makes it.
 *
 * A self-reference is ignored rather than treated as a cycle - a table pointing at itself only
 * constrains row order within it, which the source database already satisfied.
 */
export function inFkOrder(tables: Described[]): Described[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const ordered: Described[] = [];
  const state = new Map<string, "visiting" | "done">();

  function visit(table: Described): void {
    const status = state.get(table.name);
    if (status === "done") return;
    if (status === "visiting") return; // A cycle; the remaining edge is handled by deferral below.
    state.set(table.name, "visiting");

    for (const reference of table.references) {
      if (reference.target === table.name) continue;
      const target = byName.get(reference.target);
      if (target) visit(target);
    }

    state.set(table.name, "done");
    ordered.push(table);
  }

  for (const table of tables) visit(table);
  return ordered;
}

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
 * Convert one SQLite row into what the PostgreSQL column expects.
 *
 * Only booleans actually differ. Everything else - text, integers, the JSON this app keeps in text
 * columns - round-trips as-is, and coercing it would risk changing values that were already right.
 *
 * `cleared` names columns whose target table is not being migrated. They are emptied rather than
 * carried, because an id pointing into a table that stayed behind is a foreign key violation.
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
    // Ciphertext bound to the old deployment's SESSION_SECRET is re-encrypted under this one's.
    // Applied to every text column rather than to a named list: `rekey` keys off the `enc:v1:`
    // marker, so it is a no-op on the columns that hold no secret.
    // A pre-3.0 database kept some keys in plain text, which the marker never finds.
    converted[column.name] =
      typeof value === "string"
        ? sealSecretColumn(table, column.name, rekey(value))
        : (value ?? null);
  }
  return converted;
}

/**
 * The tables that can actually be written, given what the operator chose.
 *
 * A group left behind takes more with it than its own tables: `api_tokens.createdBy` is not
 * nullable, so an API token cannot exist without the user it belongs to. Rather than enumerate
 * that, this closes over the required references until nothing more falls out - so a table added
 * later is handled by its own foreign key, not by someone remembering to add it to a list.
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

/** The columns of `table` that point at something not being migrated, and so must be emptied. */
function clearedColumns(table: Described, included: Set<string>): Set<string> {
  const cleared = new Set<string>();
  for (const reference of table.references) {
    if (reference.target === table.name || included.has(reference.target)) continue;
    for (const column of reference.columns) cleared.add(column);
  }
  return cleared;
}

/**
 * Copy the chosen groups from `sqlitePath` into the connected database.
 *
 * The destination is expected to be empty - this runs during setup, before anything else has been
 * created - so rows keep their ids and conflicts are skipped rather than merged. Merging two
 * populated databases is a different problem, and guessing at it would silently pick a winner.
 *
 * `groups` defaults to everything, which is both the previous behaviour and the one the setup page
 * offers first.
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

    // A table no group claims is migrated regardless: a selection should never be the reason data
    // silently disappears. The coverage test is what catches an unclaimed table.
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

    // Read and convert everything before writing anything.
    //
    // Conversion is where a secret encrypted under the old deployment's SESSION_SECRET is
    // re-encrypted under this one's, and where a wrong key is discovered. Doing that up front is
    // the difference between a migration that refuses to start and one that stops halfway with a
    // partly populated database - which the operator is told never to retry against. A legacy
    // database is small enough to hold in memory; that is the whole cost of the guarantee.
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
              // Named, because "which of thirty tables" is the first thing anyone asks. The row is
              // not identified: its id would say little and its contents are the secret itself.
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

        // `returning` so the count is rows actually written: onConflictDoNothing silently drops
        // duplicates, and reporting the batch size would claim work a re-run did not do.
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

    return {
      tables: results,
      // Named rather than silently ignored: an operator whose old database had waf_events should
      // be told those are gone, not left to notice later.
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

/**
 * Move a serial's sequence past the highest id just inserted.
 *
 * `setval` with a third argument of false would set "next value is this"; the default true means
 * "this was the last value used", which is what a copied table needs.
 */
export async function resyncSequence(table: string, column: string): Promise<void> {
  await db.execute(
    sql`SELECT setval(
          pg_get_serial_sequence(${table}, ${column}),
          GREATEST((SELECT COALESCE(MAX(${sql.identifier(column)}), 1) FROM ${sql.identifier(table)}), 1)
        )`,
  );
}
