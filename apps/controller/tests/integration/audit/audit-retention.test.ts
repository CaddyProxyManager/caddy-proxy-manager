/**
 * The daily audit retention pass: off by default, cuts at a UTC midnight so a second pass the same
 * day removes nothing, records each removal in the chain it just anchored, and leaves Verify green.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
import { type AuditEventParams, auditEventRow, insertAuditRows } from '../../../src/lib/audit';
import { verifyAuditChain } from '../../../src/lib/audit/chain';
import {
  runAuditRetention,
  startAuditRetention,
  stopAuditRetention,
} from '../../../src/lib/audit/retention';
import { matchAuditSummary } from '../../../src/lib/audit/summary';
import { SettingValidationError } from '../../../src/lib/settings/registry';
import { invalidateSettingsCache, saveSettings } from '../../../src/lib/settings/resolve';

// What logAuditEvent does, which the preload replaces with a mock for every other suite.
const write = (params: AuditEventParams) => insertAuditRows([auditEventRow(params)]);

const NOW = Date.parse('2026-10-07T15:30:00.000Z');

beforeEach(async () => {
  ctx.db = await createTestDb();
  invalidateSettingsCache();
});

afterEach(() => {
  stopAuditRetention();
});

async function log(count: number, prefix: string) {
  for (let i = 1; i <= count; i += 1) {
    await write({
      action: 'update',
      entityType: 'proxy_host',
      entityId: i,
      summary: `${prefix} ${i}`,
    });
  }
}

/** Ages every event so far; they all go on the next pass, so their stale hashes never matter. */
async function age(createdAt: string) {
  await ctx.db.update(schema.auditEvents).set({ createdAt });
}

async function keepDays(days: number) {
  await saveSettings({ 'config:audit_log_keep_days': days });
  invalidateSettingsCache();
}

async function rows() {
  return await ctx.db.select().from(schema.auditEvents).orderBy(asc(schema.auditEvents.seq));
}

describe('audit log retention', () => {
  it('keeps everything by default', async () => {
    await log(2, 'Old');
    await age('2000-01-01T00:00:00.000Z');
    expect(await runAuditRetention(NOW)).toBeNull();
    expect(await rows()).toHaveLength(2);
  });

  it('removes what is older than the window, records it, and still verifies', async () => {
    await log(3, 'Old');
    await age('2026-09-01T12:00:00.000Z');
    await log(2, 'New');
    await keepDays(30);

    expect(await runAuditRetention(NOW)).toEqual({
      deleted: 3,
      cutoff: '2026-09-07T00:00:00.000Z',
    });
    const kept = await rows();
    expect(kept.map((row) => row.summary)).toEqual([
      'New 1',
      'New 2',
      'Removed audit events older than 2026-09-07T00:00:00.000Z (3)',
    ]);
    const pruned = kept.at(-1);
    expect(pruned).toMatchObject({
      action: 'audit_pruned',
      entityType: 'audit_log',
      actorId: null,
    });
    expect(JSON.parse(pruned?.data ?? '{}')).toEqual({
      deleted: 3,
      cutoff: '2026-09-07T00:00:00.000Z',
      keepDays: 30,
    });
    expect(pruned && matchAuditSummary(pruned)).toEqual({
      message: 'auditPruned',
      values: { cutoff: '2026-09-07T00:00:00.000Z', count: '3' },
    });

    const [head] = await ctx.db.select().from(schema.auditChain);
    expect(head.anchorSeq).toBe(3);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3, firstBroken: null });
  });

  it('removes nothing and records nothing on a second pass the same day', async () => {
    await log(1, 'Old');
    await age('2026-01-01T00:00:00.000Z');
    await keepDays(7);
    expect((await runAuditRetention(NOW))?.deleted).toBe(1);
    expect(await runAuditRetention(NOW + 6 * 3_600_000)).toEqual({
      deleted: 0,
      cutoff: '2026-09-30T00:00:00.000Z',
    });
    const pruned = await ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'audit_pruned'));
    expect(pruned).toHaveLength(1);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 1 });
  });

  it('keeps an event younger than the cutoff even when older ones go', async () => {
    await log(1, 'Old');
    await age('2026-09-29T23:59:59.999Z');
    await log(1, 'Edge');
    await ctx.db
      .update(schema.auditEvents)
      .set({ createdAt: '2026-09-30T00:00:00.000Z' })
      .where(eq(schema.auditEvents.seq, 2));
    await keepDays(7);
    expect((await runAuditRetention(NOW))?.deleted).toBe(1);
    expect((await rows()).map((row) => row.seq)).toEqual([2, 3]);
  });

  it('refuses a negative window and takes 0 to mean forever', async () => {
    const refused = await saveSettings({ 'config:audit_log_keep_days': -1 }).catch((e) => e);
    expect(refused).toBeInstanceOf(SettingValidationError);
    await keepDays(0);
    await log(1, 'Old');
    await age('2000-01-01T00:00:00.000Z');
    expect(await runAuditRetention(NOW)).toBeNull();
  });

  it('starts once and stops on losing the lead', () => {
    startAuditRetention();
    startAuditRetention();
    stopAuditRetention();
    stopAuditRetention();
  });
});
