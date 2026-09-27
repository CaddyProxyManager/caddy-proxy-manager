import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restrictDatabaseFileModes, vacuumDeletedContent } from '@/src/lib/db/sqlite-hygiene';

// chmod only toggles read-only on Windows, so the modes are asserted where they exist.
const posixIt = process.platform === 'win32' ? it.skip : it;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpm-db-hygiene-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileWithMode(path: string, mode: number) {
  writeFileSync(path, '');
  chmodSync(path, mode);
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe('restrictDatabaseFileModes', () => {
  posixIt('removes world access from the database and its journal files', () => {
    const dbPath = join(tempDir(), 'test.db');
    fileWithMode(dbPath, 0o644);
    fileWithMode(`${dbPath}-journal`, 0o666);

    restrictDatabaseFileModes(dbPath);

    expect(modeOf(dbPath)).toBe(0o640);
    expect(modeOf(`${dbPath}-journal`)).toBe(0o660);
  });

  posixIt('keeps owner and group bits, which the agent reads the volume through', () => {
    const dbPath = join(tempDir(), 'test.db');
    fileWithMode(dbPath, 0o640);
    fileWithMode(`${dbPath}-wal`, 0o600);

    restrictDatabaseFileModes(dbPath);

    expect(modeOf(dbPath)).toBe(0o640);
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
  });

  it('ignores in-memory databases and missing files', () => {
    expect(() => restrictDatabaseFileModes(':memory:')).not.toThrow();
    expect(() => restrictDatabaseFileModes(join(tempDir(), 'missing.db'))).not.toThrow();
  });
});

describe('vacuumDeletedContent', () => {
  const SECRET = 'plaintext-secret-left-in-a-free-page';

  function openWithDeletedSecret(path: string): Database {
    const database = new Database(path, { create: true });
    database.run('PRAGMA journal_mode = WAL');
    database.run('CREATE TABLE t (v TEXT)');
    database.run(`INSERT INTO t VALUES ('${SECRET}'), ('${'x'.repeat(5000)}')`);
    database.run('PRAGMA wal_checkpoint(TRUNCATE)');
    database.run(`DELETE FROM t WHERE v = '${SECRET}'`);
    database.run('PRAGMA wal_checkpoint(TRUNCATE)');
    return database;
  }

  it('rewrites the file without deleted content, once, and again when forced', () => {
    const path = join(tempDir(), 'test.db');
    const database = openWithDeletedSecret(path);
    try {
      expect(readFileSync(path).includes(SECRET)).toBe(true);

      expect(vacuumDeletedContent(database)).toBe(true);
      expect(readFileSync(path).includes(SECRET)).toBe(false);
      expect(database.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });

      expect(vacuumDeletedContent(database)).toBe(false);
      expect(vacuumDeletedContent(database, true)).toBe(true);
    } finally {
      // Windows keeps the file locked otherwise, and the temp dir cannot be removed.
      database.close(true);
    }
  });
});
