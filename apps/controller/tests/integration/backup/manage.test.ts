/** The audited layer the dashboard and GraphQL share: one event per change, no secret in a view. */
import { graphql } from 'graphql';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const manage = await import('../../../src/lib/backup/manage');
const { schema: gqlSchema } = await import('../../../src/lib/graphql/schema');
// The preload's mock: what each change would have written.
const { logAuditEvent } = await import('../../../src/lib/audit');
const logged = () =>
  vi
    .mocked(logAuditEvent)
    .mock.calls.map(
      ([event]) => event as { action: string; entityType: string; summary: string; data?: unknown },
    );

const PASSPHRASE = 'managed backup passphrase';
const dataDir = mkdtempSync(join(tmpdir(), 'cpm-backup-manage-'));
process.env.L4_PORTS_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Awaited by hand: `expect(p).rejects` has crashed Bun 1.4.2 on some of these. */
async function caught(promise: Promise<unknown>): Promise<{ code?: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; status?: number };
  }
  throw new Error('expected a rejection');
}

function localInput(name = `local-${crypto.randomUUID()}`) {
  return { name, kind: 'local', path: `manage-${crypto.randomUUID()}`, prefix: 'cpm' };
}

async function schedule(destinationId: number) {
  return manage.createScheduleAudited(
    {
      name: `nightly-${crypto.randomUUID()}`,
      destinationId,
      cron: '0 2 * * *',
      timeZone: 'UTC',
      prefix: 'nightly',
      passphrase: PASSPHRASE,
      keepLast: 3,
    },
    null,
  );
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  vi.mocked(logAuditEvent).mockClear();
});

describe('destinations', () => {
  it('audits create, update and delete, and never returns the secret', async () => {
    const created = await manage.createDestinationAudited(localInput('first'), null);
    expect(created).not.toHaveProperty('secretAccessKey');
    expect(created.hasSecret).toBe(false);
    const updated = await manage.updateDestinationAudited(
      created.id,
      { ...localInput('renamed'), path: created.path },
      null,
    );
    expect(updated.name).toBe('renamed');
    expect((await manage.listDestinations()).map((d) => d.name)).toEqual(['renamed']);
    await manage.deleteDestinationAudited(created.id, null);
    expect(await manage.listDestinations()).toEqual([]);
    expect(logged().map((e) => [e.action, e.entityType, e.summary])).toEqual([
      ['create', 'backup_destination', 'Created backup destination first'],
      ['update', 'backup_destination', 'Updated backup destination renamed'],
      ['delete', 'backup_destination', 'Deleted backup destination renamed'],
    ]);
  });

  it('tests a saved destination, an unsaved form, and refuses neither', async () => {
    const saved = await manage.createDestinationAudited(localInput(), null);
    await manage.testDestinationInput(saved.id, null);
    await manage.testDestinationInput(null, localInput());
    const missing = await caught(manage.testDestinationInput(null, null));
    expect(missing).toMatchObject({ code: 'backupDestinationNotFound', status: 404 });
  });
});

describe('schedules', () => {
  it('lists each with its next slot and last run, and drops the passphrase from views', async () => {
    const destination = await manage.createDestinationAudited(localInput(), null);
    const created = await schedule(destination.id);
    expect(created).not.toHaveProperty('passphrase');

    const now = Date.parse('2026-10-06T01:00:00Z');
    let [item] = await manage.listSchedulesWithRuns(now);
    expect(item.nextRunAt).toBe('2026-10-06T02:00:00.000Z');
    expect(item.lastRun).toBeNull();

    const run = await manage.runNowAudited(created.id, null);
    expect(run?.status).toBe('succeeded');
    [item] = await manage.listSchedulesWithRuns(now);
    expect(item.lastRun).toMatchObject({ id: run?.id, scheduleName: created.name });
    expect((await manage.listRuns()).map((r) => r.id)).toEqual([run?.id as number]);

    const disabled = await manage.setScheduleEnabledAudited(created.id, false, null);
    expect(disabled).not.toHaveProperty('passphrase');
    [item] = await manage.listSchedulesWithRuns(now);
    expect(item.nextRunAt).toBeNull();

    const updated = await manage.updateScheduleAudited(
      created.id,
      { name: 'weekly', destinationId: destination.id, cron: '0 3 * * 0' },
      null,
    );
    expect(updated).not.toHaveProperty('passphrase');
    await manage.deleteScheduleAudited(created.id, null);
    expect(await manage.listSchedulesWithRuns(now)).toEqual([]);

    const scheduleEvents = logged().filter((e) => e.entityType === 'backup_schedule');
    expect(scheduleEvents.map((e) => e.action)).toEqual([
      'create',
      'backup_run',
      'update',
      'update',
      'delete',
    ]);
    expect(scheduleEvents[1]).toMatchObject({
      summary: `Ran backup schedule ${created.name} now`,
      data: { runId: run?.id, status: 'succeeded' },
    });
    expect(scheduleEvents[4].summary).toBe('Deleted backup schedule weekly');
  });
});

describe('remote backups', () => {
  it('lists only backups, newest first, and describes one from its header', async () => {
    const destination = await manage.createDestinationAudited(localInput(), null);
    const created = await schedule(destination.id);
    const run = await manage.runNowAudited(created.id, null);
    const folder = join(dataDir, 'backups', destination.path, 'cpm', 'nightly');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'notes.txt'), 'not a backup');

    const listed = await manage.listRemoteBackups(destination.id);
    expect(listed.map((b) => b.key)).toEqual([run?.objectKey as string]);
    expect(listed[0].size).toBe(run?.bytes as number);

    const described = await manage.describeRemoteBackup(destination.id, listed[0].key);
    expect(described.newerThanThis).toBe(false);
    expect(described.counts.backup_schedules).toBe(1);
    const whole = await manage.readRemoteBackup(destination.id, listed[0].key);
    expect(whole.length).toBe(run?.bytes as number);
  });

  it('refuses a key outside the destination and an unknown destination', async () => {
    const destination = await manage.createDestinationAudited(localInput(), null);
    expect(
      await caught(manage.readRemoteBackup(destination.id, 'cpm/nightly/notes.txt')),
    ).toMatchObject({ code: 'backupObjectInvalid', status: 400 });
    expect(
      await caught(
        manage.readRemoteBackup(destination.id, '../cpm-backup-2026-10-06-02-00-00.cpmbak'),
      ),
    ).toMatchObject({ code: 'backupObjectInvalid' });
    expect(await caught(manage.listRemoteBackups(destination.id + 100))).toMatchObject({
      code: 'backupDestinationNotFound',
      status: 404,
    });
    expect(await caught(manage.readRemoteBackup(destination.id + 100, 'x'))).toMatchObject({
      code: 'backupDestinationNotFound',
    });
  });
});

describe('over GraphQL', () => {
  function as(role: string) {
    const contextValue = {
      viewer: async () => ({ userId: null, role, authMethod: 'bearer' as const }),
      access: async () => ({
        userId: null,
        role,
        isAdmin: role === 'admin',
        isOperator: false,
        grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
      }),
      rawBody: async () => '',
      request: {} as never,
    };
    return async (source: string, variableValues: Record<string, unknown> = {}) => {
      const answer = await graphql({ schema: gqlSchema, source, variableValues, contextValue });
      return { data: answer.data as Record<string, any> | null, errors: answer.errors };
    };
  }
  const admin = as('admin');

  it('manages destinations and schedules, runs one, and answers no secret', async () => {
    const destination = (
      await admin(
        'mutation ($input: BackupDestinationInput!) { createBackupDestination(input: $input) { id name hasSecret path } }',
        { input: localInput('gql') },
      )
    ).data?.createBackupDestination;
    expect(destination).toMatchObject({ name: 'gql', hasSecret: false });
    const id = destination.id;
    expect(
      (
        await admin(
          'mutation ($id: Int!, $input: BackupDestinationInput!) { updateBackupDestination(id: $id, input: $input) { name } }',
          { id, input: { ...localInput('gql-renamed'), path: destination.path } },
        )
      ).data?.updateBackupDestination.name,
    ).toBe('gql-renamed');
    expect(
      (await admin('mutation ($id: Int) { testBackupDestination(id: $id) }', { id })).data,
    ).toEqual({ testBackupDestination: true });

    const created = await admin(
      'mutation ($input: BackupScheduleInput!) { createBackupSchedule(input: $input) { id name } }',
      {
        input: {
          name: 'gql-nightly',
          destinationId: id,
          cron: '0 2 * * *',
          passphrase: PASSPHRASE,
        },
      },
    );
    expect(created.errors).toBeUndefined();
    const scheduleId = created.data?.createBackupSchedule.id;
    await admin(
      'mutation ($id: Int!, $input: BackupScheduleInput!) { updateBackupSchedule(id: $id, input: $input) { id } }',
      { id: scheduleId, input: { name: 'gql-weekly', destinationId: id, cron: '0 3 * * 0' } },
    );
    const run = (
      await admin('mutation ($id: Int!) { runBackupNow(scheduleId: $id) { id status slot } }', {
        id: scheduleId,
      })
    ).data?.runBackupNow;
    expect(run.status).toBe('succeeded');
    expect(Number.isNaN(Date.parse(run.slot))).toBe(false);

    const listed = await admin(
      '{ backupDestinations { name } backupSchedules { name lastRun { id slot } } backupRuns(limit: 5) { id } }',
    );
    expect(listed.errors).toBeUndefined();
    expect(listed.data).toEqual({
      backupDestinations: [{ name: 'gql-renamed' }],
      backupSchedules: [{ name: 'gql-weekly', lastRun: { id: run.id, slot: run.slot } }],
      backupRuns: [{ id: run.id }],
    });
    expect(JSON.stringify(listed.data)).not.toContain(PASSPHRASE);

    expect(
      (await admin('mutation ($id: Int!) { deleteBackupSchedule(id: $id) }', { id: scheduleId }))
        .data,
    ).toEqual({ deleteBackupSchedule: true });
    expect(
      (await admin('mutation ($id: Int!) { deleteBackupDestination(id: $id) }', { id })).data,
    ).toEqual({ deleteBackupDestination: true });
  });

  it('refuses anyone but an administrator', async () => {
    const answer = await as('user')('{ backupDestinations { id } }');
    expect(answer.errors?.[0]?.message).toBe('Administrator privileges required');
  });
});
