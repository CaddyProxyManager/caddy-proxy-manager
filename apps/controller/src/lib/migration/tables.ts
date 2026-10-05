/**
 * The schema's tables as data: columns, foreign keys and serial columns, read from schema.pg.ts.
 * No database: the legacy importer and the SQLite to PostgreSQL copy both order their writes by it.
 */
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.pg";

type Reference = {
  target: string;
  columns: string[];
  /** True when the row cannot exist at all without its target. */
  required: boolean;
};

export type Described = {
  key: string;
  /** Read for its shape only; rows are written to the active backend's table of the same key. */
  table: PgTable;
  name: string;
  /** `key` is the property drizzle inserts by, `name` the column in the database. */
  columns: Array<{ key: string; name: string; isBoolean: boolean }>;
  references: Reference[];
  /** The serial column whose sequence needs resyncing, if the table has one. */
  serialColumn: string | null;
};

export function describeTables(): Described[] {
  const described: Described[] = [];

  for (const [key, value] of Object.entries(schema)) {
    // `is` is the only reliable runtime test: `$inferSelect` is a type-only phantom.
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
      columns: Object.entries(getTableColumns(table)).map(([columnKey, column]) => ({
        key: columnKey,
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

/** Self-references are ignored: they only constrain row order, which the source satisfied. */
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
