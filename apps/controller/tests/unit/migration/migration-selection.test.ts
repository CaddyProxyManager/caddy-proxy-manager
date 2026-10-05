/**
 * Coverage matters most: the importer copies unclaimed tables anyway, but a table left out of every
 * group could never be declined. The first test turns that into a build failure.
 */
import { describe, expect, it } from 'bun:test';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import * as schema from '@/src/lib/db/schema.pg';
import {
  ALL_MIGRATION_GROUP_IDS,
  MIGRATION_GROUPS,
  groupForTable,
  parseMigrationSelection,
  tablesForSelection,
  withRequiredGroups,
} from '@/src/lib/migration/selection';

/** Read the way the importer reads them. */
function schemaTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    try {
      names.push(getTableConfig(value as PgTable).name);
    } catch {
      // Not a table after all; the importer skips these the same way.
    }
  }
  return names;
}

describe('group coverage', () => {
  it('claims every table in the schema', () => {
    const unclaimed = schemaTableNames().filter((name) => groupForTable(name) === null);
    expect(unclaimed).toEqual([]);
  });

  it('names only tables that exist', () => {
    const known = new Set(schemaTableNames());
    const unknown = MIGRATION_GROUPS.flatMap((group) => group.tables).filter(
      (table) => !known.has(table),
    );
    expect(unknown).toEqual([]);
  });

  it('claims each table exactly once', () => {
    const seen = new Map<string, number>();
    for (const group of MIGRATION_GROUPS) {
      for (const table of group.tables) seen.set(table, (seen.get(table) ?? 0) + 1);
    }
    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
  });
});

describe('dependencies', () => {
  it('brings certificates, access lists and agents along with proxy hosts', () => {
    // Hosts alone would import fine, and publish a host once behind an access list with nothing in
    // front of it, or one pinned to one agent as served by the whole fleet.
    expect(withRequiredGroups(['proxyHosts'])).toEqual([
      'proxyHosts',
      'certificates',
      'accessLists',
      'agents',
    ]);
  });

  it('leaves a group with no dependencies alone', () => {
    expect(withRequiredGroups(['users'])).toEqual(['users']);
  });

  it('returns groups in declaration order however they were chosen', () => {
    expect(withRequiredGroups(['auditLog', 'users'])).toEqual(['users', 'auditLog']);
  });
});

describe('parsing what the form posted', () => {
  it('drops values that are not groups', () => {
    expect(parseMigrationSelection(['users', 'everything', '../etc/passwd'])).toEqual(['users']);
  });

  it('closes over dependencies the browser did not send', () => {
    // The checkboxes do this too, but the request is untrusted strings.
    expect(parseMigrationSelection(['proxyHosts'])).toEqual([
      'proxyHosts',
      'certificates',
      'accessLists',
      'agents',
    ]);
  });

  it('is empty when nothing recognisable was posted', () => {
    expect(parseMigrationSelection([])).toEqual([]);
    expect(parseMigrationSelection(['nonsense'])).toEqual([]);
  });
});

describe('tablesForSelection', () => {
  it('covers the whole schema when everything is chosen', () => {
    const tables = tablesForSelection(ALL_MIGRATION_GROUP_IDS);
    for (const name of schemaTableNames()) expect(tables.has(name)).toBe(true);
  });

  it('leaves the users tables out when users are not chosen', () => {
    const tables = tablesForSelection(['proxyHosts', 'settings']);
    expect(tables.has('users')).toBe(false);
    expect(tables.has('api_tokens')).toBe(false);
    expect(tables.has('proxy_hosts')).toBe(true);
    expect(tables.has('access_lists')).toBe(true);
  });
});
