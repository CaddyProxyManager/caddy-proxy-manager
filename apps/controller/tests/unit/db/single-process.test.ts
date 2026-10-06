/**
 * A second controller on one SQLite file is refused, by a lock the OS drops with the process that
 * held it - so a crash leaves nothing behind to refuse the restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lockDatabaseFile, SqliteInUseError } from '@/src/lib/db/single-process';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cpm-sqlite-lock-'));
  path = join(dir, 'cpm.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A separate process, as a second controller would be: prints `locked` or `free`. */
async function inAnotherProcess(): Promise<string> {
  const script = `
    const { Database } = require('bun:sqlite');
    const lock = new Database(${JSON.stringify(`${path}.controller-lock`)}, { create: true });
    try {
      lock.run('PRAGMA busy_timeout = 0');
      lock.run('PRAGMA locking_mode = EXCLUSIVE');
      lock.run('BEGIN EXCLUSIVE');
      console.log('free');
    } catch {
      console.log('locked');
    }
    lock.close(true);
  `;
  const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  await child.exited;
  return (await new Response(child.stdout).text()).trim();
}

describe('one controller per SQLite file', () => {
  it('refuses a second holder while the first has it', () => {
    const first = lockDatabaseFile(path);
    try {
      expect(() => lockDatabaseFile(path)).toThrow(SqliteInUseError);
    } finally {
      first.close(true);
    }
  });

  it('is held against another process, and let go with the connection', async () => {
    const first = lockDatabaseFile(path);
    expect(await inAnotherProcess()).toBe('locked');
    first.close(true);
    expect(await inAnotherProcess()).toBe('free');
  });

  it('takes the lock straight after another process held it and exited', async () => {
    expect(await inAnotherProcess()).toBe('free');
    const lock = lockDatabaseFile(path);
    lock.close(true);
  });
});
