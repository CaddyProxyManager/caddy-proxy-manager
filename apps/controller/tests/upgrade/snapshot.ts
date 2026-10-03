/**
 * Every row of every table, read through the raw driver so neither checkout's schema filters what
 * the other one wrote. Imports nothing from the app: both halves of the harness load it.
 */
import type { Database } from 'bun:sqlite';
import type { SQL } from 'bun';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

export type RawClient = SQL | Database;

function isSqlite(client: RawClient): client is Database {
  return typeof (client as Database).query === 'function' && !('unsafe' in client);
}

export async function rawQuery(client: RawClient, statement: string): Promise<Row[]> {
  if (isSqlite(client)) return client.query(statement).all() as Row[];
  return [...((await client.unsafe(statement)) as Row[])];
}

export async function tableNames(client: RawClient): Promise<string[]> {
  const rows = isSqlite(client)
    ? await rawQuery(
        client,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
          "AND name <> '__drizzle_migrations'",
      )
    : await rawQuery(
        client,
        'SELECT table_name AS name FROM information_schema.tables ' +
          "WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
      );
  return rows.map((row) => String(row.name)).sort();
}

/** JSON-safe and stable: what the files between the two processes can carry. */
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

export async function snapshotTables(client: RawClient): Promise<Tables> {
  const tables: Tables = {};
  for (const name of await tableNames(client)) {
    const [first] = await rawQuery(client, `SELECT * FROM "${name}" LIMIT 1`);
    const width = first ? Object.keys(first).length : 0;
    // Every column, so tables without a single-column key still come back in one order.
    const order = width > 0 ? ` ORDER BY ${Array.from({ length: width }, (_, i) => i + 1)}` : '';
    const rows = await rawQuery(client, `SELECT * FROM "${name}"${order}`);
    tables[name] = rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)])),
    );
  }
  return tables;
}

/** Leaf paths where two JSON values differ, `$.apps.http...` style. */
export function jsonDiff(before: unknown, after: unknown, path = '$'): string[] {
  if (Object.is(before, after)) return [];
  const bothObjects =
    before !== null && after !== null && typeof before === 'object' && typeof after === 'object';
  if (!bothObjects || Array.isArray(before) !== Array.isArray(after)) {
    return [`${path}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
  }
  const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
  return [...keys].flatMap((key) =>
    jsonDiff(
      (before as Record<string, unknown>)[key],
      (after as Record<string, unknown>)[key],
      Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`,
    ),
  );
}
