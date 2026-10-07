import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cronHandler, scheduleJobs } from '../../../src/lib/backup/runner';

const schedule = (id: number, cron: string, timeZone = 'UTC') => ({
  id,
  name: `schedule ${id}`,
  cron,
  timeZone,
});

describe('starting the cron jobs', () => {
  it('starts every valid schedule when one row is refused', () => {
    const { jobs, failed } = scheduleJobs(
      [
        schedule(1, '0 2 * * *'),
        schedule(2, 'not cron'),
        schedule(3, '0 3 * * *', 'Nope/Zone'),
        schedule(4, '*/5 * * * *'),
      ],
      () => async () => {},
    );
    try {
      expect([...jobs.keys()]).toEqual([1, 4]);
      expect(failed).toEqual([2, 3]);
    } finally {
      for (const job of jobs.values()) job.stop();
    }
  });

  it('hands each job the schedule its own handler was made for', () => {
    const made: number[] = [];
    const { jobs } = scheduleJobs(
      [schedule(7, '0 1 * * *'), schedule(8, '0 2 * * *')],
      (s) => {
        made.push(s.id);
        return async () => {};
      },
      () => ({ stop() {}, unref() {} }),
    );
    expect(made).toEqual([7, 8]);
    expect(jobs.size).toBe(2);
  });
});

describe('the cron handler', () => {
  it('catches a thrown or rejected run and reports it, never letting it escape', async () => {
    const seen: string[] = [];
    const onError = (error: unknown) => seen.push((error as Error).message);
    await expect(
      cronHandler(() => {
        throw new Error('thrown');
      }, onError)(),
    ).resolves.toBeUndefined();
    await expect(
      cronHandler(() => Promise.reject(new Error('rejected')), onError)(),
    ).resolves.toBeUndefined();
    // Even a reporter that fails itself stays inside.
    await expect(
      cronHandler(
        () => Promise.reject(new Error('again')),
        () => {
          throw new Error('reporter broke');
        },
      )(),
    ).resolves.toBeUndefined();
    expect(seen).toEqual(['thrown', 'rejected']);
  });

  it('keeps a bun process alive when a fired job fails, where an unwrapped one fails it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpm-cron-'));
    const runner = resolve(import.meta.dir, '../../../src/lib/backup/runner.ts').replaceAll(
      '\\',
      '/',
    );
    // As Bun.cron calls a handler: fire and forget, so a rejection has nobody awaiting it.
    const script = (wrapped: boolean) => `
      const { cronHandler } = await import(${JSON.stringify(runner)});
      const failing = async () => { throw new Error("backup failed"); };
      const handler = ${wrapped ? 'cronHandler(failing, () => {})' : 'failing'};
      void handler();
      await Bun.sleep(300);
      console.log("alive");
    `;
    try {
      const results: Record<string, { code: number; out: string }> = {};
      for (const wrapped of [true, false]) {
        const file = join(dir, `${wrapped ? 'wrapped' : 'bare'}.ts`);
        writeFileSync(file, script(wrapped));
        const child = Bun.spawn([process.execPath, file], {
          cwd: resolve(import.meta.dir, '../../..'),
          env: { ...process.env, TEST_DB: 'sqlite', DATABASE_URL: 'file::memory:' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        results[wrapped ? 'wrapped' : 'bare'] = { code, out: out.trim() };
      }
      expect(results.wrapped).toEqual({ code: 0, out: 'alive' });
      // Bun lets the script finish, then exits 1 for the rejection nobody handled.
      expect(results.bare.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
