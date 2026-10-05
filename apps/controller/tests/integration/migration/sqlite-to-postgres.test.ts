/**
 * The SQLite to PostgreSQL copy against a real server: a current SQLite database in, the same
 * rows out, sequences moved past the copied ids and the audit hash chain untouched. PostgreSQL
 * only: under `test:sqlite` there is no server to copy into.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SQL } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  CopyRefusedError,
  copySqliteToPostgres,
} from '../../../src/lib/migration/sqlite-to-postgres';
import { MIGRATION_GROUPS } from '../../../src/lib/migration/selection';

const adminUrl = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = resolve(import.meta.dir, '../../../drizzle');
const NOW = '2026-01-02T03:04:05.000Z';

let dir: string;
let sqlitePath: string;
let databaseName: string;
let target: SQL;
let admin: SQL;

function seedSource(path: string): void {
  const source = new Database(path, { create: true });
  migrate(drizzle(source), { migrationsFolder: join(MIGRATIONS, 'sqlite') });
  source.run(
    `INSERT INTO users (id, email, role, status, emailVerified, twoFactorEnabled, createdAt, updatedAt)
     VALUES (7, 'admin@example.com', 'admin', 'active', 1, 1, '${NOW}', '${NOW}'),
            (9, 'user@example.com', 'user', 'active', 0, 0, '${NOW}', '${NOW}')`,
  );
  source.run(
    `INSERT INTO api_tokens (id, name, tokenHash, createdBy, createdAt, scope, permissions)
     VALUES (3, 'ci', 'hash-1', 7, '${NOW}', 'custom', '["hosts:read"]')`,
  );
  source.run(
    `INSERT INTO access_lists (id, name, createdAt, updatedAt) VALUES (4, 'office', '${NOW}', '${NOW}')`,
  );
  // An ASN past 2^31, which a 32-bit column would refuse.
  source.run(
    `INSERT INTO access_list_ip_rules (accessListId, action, asn, sortOrder, createdAt, updatedAt)
     VALUES (4, 'deny', 4200000000, 0, '${NOW}', '${NOW}')`,
  );
  source.run(
    `INSERT INTO audit_events (id, userId, actorId, action, entityType, summary, createdAt, seq, prevHash, hash)
     VALUES (11, 7, 7, 'create', 'access_list', 'Created access list office', '${NOW}', 1, '${'0'.repeat(64)}', '${'a'.repeat(64)}')`,
  );
  source.run(`UPDATE audit_chain SET headSeq = 1, headHash = '${'a'.repeat(64)}', anchorSeq = 0`);
  source.close(true);
}

beforeAll(async () => {
  if (!adminUrl) return;
  dir = mkdtempSync(join(tmpdir(), 'cpm-copy-'));
  sqlitePath = join(dir, 'cpm.db');
  seedSource(sqlitePath);
  databaseName = `cpm_copy_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  admin = new SQL({ url: adminUrl, max: 1 });
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  target = new SQL({ url: url.toString(), max: 2 });
});

afterAll(async () => {
  if (!adminUrl) return;
  await target?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!adminUrl)('copying SQLite into PostgreSQL', () => {
  // Steps of one copy, in order: bun randomises tests, so they share a single test.
  it('dry-runs, copies, verifies and then refuses a second copy', async () => {
    const dry = await copySqliteToPostgres({
      sqlitePath,
      target,
      migrationsFolder: MIGRATIONS,
      dryRun: true,
    });
    expect(dry.targetUnmigrated).toBe(true);
    expect(dry.tables.find((table) => table.table === 'users')?.source).toBe(2);
    const [{ present }] = await target.unsafe(
      `SELECT to_regclass('public.users') IS NOT NULL AS present`,
    );
    expect(present).toBe(false);

    const report = await copySqliteToPostgres({ sqlitePath, target, migrationsFolder: MIGRATIONS });
    expect(report.mismatches).toEqual([]);
    for (const table of report.tables) expect(table.after).toBe(table.source);

    const [copiedAdmin] = await target.unsafe(
      `SELECT id, "emailVerified", "twoFactorEnabled" FROM users WHERE id = 7`,
    );
    expect(copiedAdmin).toEqual({ id: 7, emailVerified: true, twoFactorEnabled: true });
    const [token] = await target.unsafe(`SELECT scope, permissions FROM api_tokens`);
    expect(token).toEqual({ scope: 'custom', permissions: '["hosts:read"]' });
    const [rule] = await target.unsafe(`SELECT asn FROM access_list_ip_rules`);
    expect(Number(rule.asn)).toBe(4200000000);
    const [event] = await target.unsafe(`SELECT seq, hash, "actorId" FROM audit_events`);
    expect(event).toEqual({ seq: 1, hash: 'a'.repeat(64), actorId: 7 });
    const chain = await target.unsafe(`SELECT "headSeq", "headHash" FROM audit_chain`);
    expect(chain).toEqual([{ headSeq: 1, headHash: 'a'.repeat(64) }]);

    // The sequence moved past the copied ids, so the next row does not collide.
    const [next] = await target.unsafe(
      `INSERT INTO users (email, role, status, "emailVerified", "twoFactorEnabled", "createdAt", "updatedAt")
       VALUES ('new@example.com', 'user', 'active', false, false, '${NOW}', '${NOW}') RETURNING id`,
    );
    expect(next.id).toBe(10);

    await expect(
      copySqliteToPostgres({ sqlitePath, target, migrationsFolder: MIGRATIONS }),
    ).rejects.toBeInstanceOf(CopyRefusedError);
  });

  it('copies every table the migration groups name', () => {
    // Coverage is the schema's, not a list: a table no group names would still be copied.
    const named = new Set(MIGRATION_GROUPS.flatMap((group) => group.tables));
    expect(named.has('audit_chain')).toBe(true);
    expect(named.has('api_tokens')).toBe(true);
  });
});

describe('a source that is not current', () => {
  it('is refused before anything is read from the target', async () => {
    const stale = join(mkdtempSync(join(tmpdir(), 'cpm-copy-stale-')), 'old.db');
    const source = new Database(stale, { create: true });
    source.run('CREATE TABLE users (id integer primary key)');
    source.close(true);
    await expect(
      copySqliteToPostgres({
        sqlitePath: stale,
        target: {} as SQL,
        migrationsFolder: MIGRATIONS,
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(CopyRefusedError);
  });
});
