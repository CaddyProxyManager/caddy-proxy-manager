/** The SQLite migration fills a uuid on every existing host, so a URL can name rows that predate it. */
import { Database } from 'bun:sqlite';
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = join(import.meta.dir, '../../../drizzle/sqlite/0039_proxy_host_uuid.sql');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('0039_proxy_host_uuid', () => {
  it('backfills distinct v4 uuids and enforces uniqueness', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE proxy_hosts (id integer primary key, name text)');
    db.run('CREATE TABLE l4_proxy_hosts (id integer primary key, name text)');
    for (const table of ['proxy_hosts', 'l4_proxy_hosts']) {
      for (let i = 1; i <= 50; i++) db.run(`INSERT INTO ${table} (name) VALUES ('h${i}')`);
    }

    for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
      db.run(statement);
    }

    for (const table of ['proxy_hosts', 'l4_proxy_hosts']) {
      const rows = db.query(`SELECT uuid FROM ${table}`).all() as { uuid: string }[];
      expect(rows).toHaveLength(50);
      for (const { uuid } of rows) expect(uuid).toMatch(UUID);
      expect(new Set(rows.map((row) => row.uuid)).size).toBe(50);
    }
    expect(() =>
      db.run("INSERT INTO proxy_hosts (name, uuid) SELECT 'dup', uuid FROM proxy_hosts LIMIT 1"),
    ).toThrow();
    db.close(true);
  });
});
