/** Schedules, slot claims, runs, catch-up and their signals, on both dialects, to a local folder. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
const { createDestination } = await import('../../../src/lib/backup/destinations');
const { createSchedule, updateSchedule } = await import('../../../src/lib/backup/schedules');
const { claimRun, failStaleRuns, listRuns, latestRuns } = await import(
  '../../../src/lib/backup/runs'
);
const { catchUpSchedules, runBackupSchedule } = await import('../../../src/lib/backup/runner');
const { listEnabledSchedules } = await import('../../../src/lib/backup/schedules');
const { readBackupHeader, openBackup } = await import('../../../src/lib/backup/format');
const { decryptSecret } = await import('../../../src/lib/secrets');
const { collectAttention } = await import('../../../src/lib/attention');

const PASSPHRASE = 'scheduled backup passphrase';
const dataDir = mkdtempSync(join(tmpdir(), 'cpm-scheduled-'));
process.env.L4_PORTS_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const adminAccess = {
  isAdmin: true,
  isOperator: true,
  grants: { proxyHosts: new Set<number>(), agents: new Set<number>() },
} as never;

async function localSchedule(overrides: Record<string, unknown> = {}) {
  const destination = await createDestination({
    name: `local-${crypto.randomUUID()}`,
    kind: 'local',
    path: 'scheduled',
    prefix: 'cpm',
  });
  return createSchedule({
    name: `nightly-${crypto.randomUUID()}`,
    destinationId: destination.id,
    cron: '0 2 * * *',
    timeZone: 'UTC',
    prefix: 'nightly',
    passphrase: PASSPHRASE,
    keepLast: 2,
    ...overrides,
  });
}

beforeEach(async () => {
  ctx.db = await createTestDb();
});

describe('schedules', () => {
  it('stores the passphrase encrypted and refuses an expression that never fires', async () => {
    const schedule = await localSchedule();
    const [row] = await ctx.db.select().from(schema.backupSchedules);
    expect(row.passphrase.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(row.passphrase)).toBe(PASSPHRASE);
    await expect(
      updateSchedule(schedule.id, {
        name: schedule.name,
        destinationId: schedule.destinationId,
        cron: '0 0 30 2 *',
      }),
    ).rejects.toMatchObject({ code: 'backupCronNeverFires' });
    await expect(
      updateSchedule(schedule.id, {
        name: schedule.name,
        destinationId: schedule.destinationId,
        cron: '0 2 * * *',
        timeZone: 'Atlantis/Lost',
      }),
    ).rejects.toMatchObject({ code: 'backupTimeZoneInvalid' });
  });

  it('keeps the stored passphrase when an update leaves it blank', async () => {
    const schedule = await localSchedule();
    const updated = await updateSchedule(schedule.id, {
      name: schedule.name,
      destinationId: schedule.destinationId,
      cron: '30 3 * * *',
    });
    expect(updated.passphrase).toBe(PASSPHRASE);
    expect(updated.scheduledSince >= schedule.scheduledSince).toBe(true);
  });
});

describe('slot claims', () => {
  it('lets exactly one of two concurrent claims of a slot win', async () => {
    const schedule = await localSchedule();
    const slot = Date.parse('2026-10-06T02:00:00Z');
    const claims = await Promise.all([
      claimRun(schedule.id, slot, 'schedule', 'replica-a'),
      claimRun(schedule.id, slot, 'catch-up', 'replica-b'),
    ]);
    expect(claims.filter((id) => id !== null)).toHaveLength(1);
    expect(await ctx.db.select().from(schema.backupRuns)).toHaveLength(1);
    // Another slot of the same schedule is its own claim.
    expect(await claimRun(schedule.id, slot + 86_400_000, 'schedule')).not.toBeNull();
  });
});

describe('runs', () => {
  it('writes a sealed backup and records status, key, bytes and duration', async () => {
    const schedule = await localSchedule();
    const slot = Date.parse('2026-10-06T02:00:00Z');
    const runId = await runBackupSchedule(schedule.id, slot, 'schedule');
    expect(runId).not.toBeNull();
    const [run] = await listRuns();
    expect(run).toMatchObject({
      status: 'succeeded',
      objectKey: 'cpm/nightly/cpm-backup-2026-10-06-02-00-00.cpmbak',
      error: null,
      scheduleName: schedule.name,
    });
    expect(run.bytes).toBeGreaterThan(0);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.finishedAt).not.toBeNull();
    const file = readFileSync(join(dataDir, 'backups', 'scheduled', run.objectKey as string));
    expect(file.length).toBe(run.bytes as number);
    expect(readBackupHeader(file).header.version).toBe(3);
    const opened = await openBackup(file, PASSPHRASE);
    // The run's own row was being written as the backup was made: runs are never in one.
    expect(opened.tables.backup_runs).toBeUndefined();
    expect(opened.tables.backup_schedules).toHaveLength(1);
    // The same slot again is somebody else's.
    expect(await runBackupSchedule(schedule.id, slot, 'catch-up')).toBeNull();
  });

  it('prunes to the retention policy after a run', async () => {
    const schedule = await localSchedule({ keepLast: 2 });
    for (const day of ['03', '04', '05', '06']) {
      await runBackupSchedule(schedule.id, Date.parse(`2026-10-${day}T02:00:00Z`), 'schedule');
    }
    const dir = join(dataDir, 'backups', 'scheduled', 'cpm', 'nightly');
    expect(existsSync(join(dir, 'cpm-backup-2026-10-06-02-00-00.cpmbak'))).toBe(true);
    expect(existsSync(join(dir, 'cpm-backup-2026-10-05-02-00-00.cpmbak'))).toBe(true);
    expect(existsSync(join(dir, 'cpm-backup-2026-10-04-02-00-00.cpmbak'))).toBe(false);
  });

  it('records a failure with its error, and Needs attention shows it', async () => {
    const destination = await createDestination({
      name: 'unreachable',
      kind: 's3',
      endpoint: 'http://127.0.0.1:1',
      bucket: 'nowhere',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    const schedule = await createSchedule({
      name: 'doomed',
      destinationId: destination.id,
      cron: '0 2 * * *',
      passphrase: PASSPHRASE,
    });
    await runBackupSchedule(schedule.id, Date.parse('2026-10-06T02:00:00Z'), 'schedule');
    const [run] = await listRuns({ scheduleId: schedule.id });
    expect(run.status).toBe('failed');
    expect(run.error).toBeTruthy();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);

    const attention = await collectAttention(adminAccess);
    const item = attention.items.find((entry) => entry.id === `backup-failed:${schedule.id}`);
    expect(item).toMatchObject({ code: 'backupFailed', values: { name: 'doomed' } });
  });

  it('marks a run left running by a dead process as failed', async () => {
    const schedule = await localSchedule();
    await ctx.db.insert(schema.backupRuns).values({
      scheduleId: schedule.id,
      slot: 1,
      trigger: 'schedule',
      status: 'running',
      startedAt: new Date(Date.now() - 7 * 3_600_000).toISOString(),
    });
    expect(await failStaleRuns()).toBe(1);
    const [run] = await listRuns();
    expect(run).toMatchObject({
      status: 'failed',
      errorCode: expect.stringContaining('backupRunInterrupted'),
    });
  });
});

describe('catch-up on taking over', () => {
  it('runs only the latest missed slot, once', async () => {
    const schedule = await localSchedule();
    await ctx.db.update(schema.backupSchedules).set({ scheduledSince: '2026-09-01T00:00:00.000Z' });
    const now = Date.parse('2026-10-06T12:00:00Z');
    const schedules = await listEnabledSchedules();
    expect(await catchUpSchedules(schedules, now)).toEqual([schedule.id]);
    expect(await catchUpSchedules(schedules, now)).toEqual([]);
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'catch-up',
      slot: Date.parse('2026-10-06T02:00:00Z'),
    });
    const latest = await latestRuns([schedule.id]);
    expect(latest.get(schedule.id)?.scheduledSlot).toBe(Date.parse('2026-10-06T02:00:00Z'));
  });

  it('owes nothing for a slot from before the schedule existed', async () => {
    await localSchedule();
    const schedules = await listEnabledSchedules();
    expect(await catchUpSchedules(schedules, Date.now())).toEqual([]);
  });

  it('flags a schedule whose last two slots never ran', async () => {
    const schedule = await localSchedule();
    await ctx.db.update(schema.backupSchedules).set({ scheduledSince: '2020-01-01T00:00:00.000Z' });
    const attention = await collectAttention(adminAccess);
    expect(attention.items.map((item) => item.id)).toContain(`backup-overdue:${schedule.id}`);
  });
});
