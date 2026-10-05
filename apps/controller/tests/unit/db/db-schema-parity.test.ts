/**
 * schema.ts types the SQLite tables as their PostgreSQL twins, which only holds while the two
 * (and the SQLite migrations) stay structurally identical; drift is otherwise silent.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { is } from 'drizzle-orm';
import { getTableConfig as getPgTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generate } from '../../../scripts/generate-sqlite-schema';
import * as pgSchema from '../../../src/lib/db/schema.pg';
import * as sqliteSchema from '../../../src/lib/db/schema.sqlite';

type Shape = {
  name: string;
  columns: Array<{
    name: string;
    type: string;
    notNull: boolean;
    primary: boolean;
    default: unknown;
  }>;
  indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
  foreignKeys: Array<{ columns: string[]; target: string; onDelete: string | undefined }>;
};

/** SQLite stores booleans and serials as integers and a bounded string as text(n). */
const TYPE_ALIASES: Record<string, string> = { boolean: 'integer', PgSerial: 'integer' };

function shape(config: any): Shape {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    name: config.name,
    columns: config.columns
      .map((column: any) => ({
        name: column.name,
        type: (
          TYPE_ALIASES[column.columnType] ??
          TYPE_ALIASES[column.dataType] ??
          column.getSQLType()
        ).replace(/^varchar\(/, 'text('),
        notNull: column.notNull,
        primary: column.primary,
        default: column.default,
      }))
      .sort(byName),
    indexes: config.indexes
      .map((index: any) => ({
        name: index.config.name,
        unique: Boolean(index.config.unique),
        columns: index.config.columns.map((column: any) => column.name),
      }))
      .sort(byName),
    foreignKeys: config.foreignKeys
      .map((foreignKey: any) => {
        const reference = foreignKey.reference();
        return {
          columns: reference.columns.map((column: any) => column.name),
          target: reference.foreignTable[Symbol.for('drizzle:Name')] as string,
          onDelete: foreignKey.onDelete,
        };
      })
      .sort((a: { columns: string[] }, b: { columns: string[] }) =>
        a.columns.join().localeCompare(b.columns.join()),
      ),
  };
}

function pgShapes(): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const [key, value] of Object.entries(pgSchema)) {
    if (is(value, PgTable)) out.set(key, shape(getPgTableConfig(value)));
  }
  return out;
}

function sqliteShapes(): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const [key, value] of Object.entries(sqliteSchema)) {
    if (is(value, SQLiteTable)) out.set(key, shape(getSqliteTableConfig(value)));
  }
  return out;
}

describe('schema parity', () => {
  it('schema.sqlite.ts is what the generator produces from schema.pg.ts', () => {
    const onDisk = readFileSync(
      resolve(import.meta.dir, '../../../src/lib/db/schema.sqlite.ts'),
      'utf8',
    );
    // Run `bun scripts/generate-sqlite-schema.ts` if this fails.
    expect(onDisk).toBe(generate());
  });

  it('declares the same tables with the same columns, indexes and foreign keys', () => {
    const pg = pgShapes();
    const sqlite = sqliteShapes();
    expect([...sqlite.keys()].sort()).toEqual([...pg.keys()].sort());
    for (const [key, table] of pg) {
      expect({ key, ...sqlite.get(key) }).toEqual({ key, ...table });
    }
  });

  it('src/lib/db/schema.ts re-exports every table', () => {
    const source = readFileSync(resolve(import.meta.dir, '../../../src/lib/db/schema.ts'), 'utf8');
    const destructured = /export const \{([^}]*)\} = activeSchema/.exec(source)?.[1] ?? '';
    const names = destructured
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual([...pgShapes().keys()].sort());
  });

  it('exports no null-prototype object, which Better Auth cannot walk under Vite', async () => {
    // drizzle's is() throws on a module namespace in Better Auth's check: every dev sign-in 500s.
    const schema = await import('../../../src/lib/db/schema');
    expect(Object.getPrototypeOf(schema.activeSchema)).not.toBeNull();
  });

  it('the SQLite migrations build exactly the tables schema.sqlite.ts declares', () => {
    const folder = resolve(import.meta.dir, '../../../drizzle/sqlite');
    const journal = JSON.parse(readFileSync(resolve(folder, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const database = new Database(':memory:');
    try {
      for (const { tag } of journal.entries) {
        database.run(
          readFileSync(resolve(folder, `${tag}.sql`), 'utf8')
            .split('--> statement-breakpoint')
            .join('\n'),
        );
      }

      const built = new Map<string, Array<{ name: string; type: string; notNull: boolean }>>();
      const tables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      for (const { name } of tables) {
        const columns = database
          .query<{ name: string; type: string; notnull: number }, []>(
            `PRAGMA table_info("${name}")`,
          )
          .all()
          .map((column) => ({
            name: column.name,
            type: column.type.toLowerCase(),
            notNull: column.notnull === 1,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        built.set(name, columns);
      }

      const declared = new Map(
        [...sqliteShapes().values()].map((table) => [
          table.name,
          table.columns.map(({ name, type, notNull }) => ({ name, type, notNull })),
        ]),
      );
      // Run `DATABASE_URL=file:./data/cpm.db bun run db:generate` if this fails.
      expect(Object.fromEntries(built)).toEqual(Object.fromEntries(declared));
    } finally {
      database.close(true);
    }
  });
});
