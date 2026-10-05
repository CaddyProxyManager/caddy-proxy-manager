import { beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb, createTestDbBefore } = await import('../../helpers/db');

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
import { type AuditEventParams, auditEventRow, insertAuditRows } from '../../../src/lib/audit';
import {
  GENESIS_HASH,
  auditEventHash,
  canonicalAuditContent,
  chainedAuditInsert,
  prepareAuditChain,
  pruneAuditEvents,
  reanchorAuditChain,
  verifyAuditChain,
} from '../../../src/lib/audit/chain';
import { config } from '../../../src/lib/config';
import { derivePurposeKey } from '../../../src/lib/secrets/derived-key';

const { runInTransaction } = dbModuleMock(() => ctx.db);

// What logAuditEvent does, which the preload replaces with a mock for every other suite.
const write = (params: AuditEventParams) => insertAuditRows([auditEventRow(params)]);

beforeEach(async () => {
  ctx.db = await createTestDb();
});

async function log(count: number, prefix = 'Event') {
  for (let i = 1; i <= count; i += 1) {
    await write({
      action: 'update',
      entityType: 'proxy_host',
      entityId: i,
      summary: `${prefix} ${i}`,
    });
  }
}

async function chained() {
  return await ctx.db.select().from(schema.auditEvents).orderBy(asc(schema.auditEvents.seq));
}

describe('audit hash chain', () => {
  it('links each event to the one before, starting from the genesis marker', async () => {
    await log(3);
    const rows = await chained();
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(rows[2].prevHash).toBe(rows[1].hash);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3, firstBroken: null });
  });

  it('verifies an empty log', async () => {
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 0, legacy: 0 });
  });

  it('reports an edited event as the first broken link', async () => {
    await log(4);
    const rows = await chained();
    await ctx.db
      .update(schema.auditEvents)
      .set({ summary: 'Something else' })
      .where(eq(schema.auditEvents.id, rows[1].id));
    expect(await verifyAuditChain()).toMatchObject({
      ok: false,
      checked: 1,
      firstBroken: { reason: 'content', seq: 2, eventId: rows[1].id },
    });
  });

  it('notices a changed actor even after the user column was cleared', async () => {
    await ctx.db.insert(schema.users).values({
      id: 5,
      email: 'a@example.com',
      role: 'admin',
      provider: 'credentials',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await write({ userId: 5, action: 'create', entityType: 'group', summary: 'x' });
    // A deleted user nulls userId through the foreign key: the chain hashes actorId instead.
    await ctx.db.delete(schema.users).where(eq(schema.users.id, 5));
    expect((await verifyAuditChain()).ok).toBe(true);
    await ctx.db.update(schema.auditEvents).set({ actorId: 6 });
    expect((await verifyAuditChain()).firstBroken?.reason).toBe('content');
  });

  it('reports a deleted event in the middle as missing', async () => {
    await log(3);
    await ctx.db.delete(schema.auditEvents).where(eq(schema.auditEvents.seq, 2));
    expect((await verifyAuditChain()).firstBroken).toEqual({
      reason: 'missing',
      seq: 2,
      eventId: null,
    });
  });

  it('reports the newest events removed', async () => {
    await log(3);
    await ctx.db.delete(schema.auditEvents).where(eq(schema.auditEvents.seq, 3));
    expect((await verifyAuditChain()).firstBroken).toMatchObject({ reason: 'head', seq: 3 });
  });

  it('reports a re-hashed edit, since the head no longer matches', async () => {
    await log(2);
    const [, second] = await chained();
    const forged = { ...second, summary: 'Forged', seq: second.seq as number };
    await ctx.db
      .update(schema.auditEvents)
      .set({ summary: 'Forged', hash: auditEventHash(second.prevHash as string, forged) })
      .where(eq(schema.auditEvents.id, second.id));
    expect((await verifyAuditChain()).firstBroken?.reason).toBe('head');
  });

  it('reports an event inserted around the chain', async () => {
    await log(1);
    const [row] = await ctx.db
      .insert(schema.auditEvents)
      .values({ action: 'create', entityType: 'user', createdAt: new Date().toISOString() })
      .returning();
    expect((await verifyAuditChain()).firstBroken).toEqual({
      reason: 'unchained',
      seq: null,
      eventId: row.id,
    });
  });

  it('keeps the chain whole under concurrent writers', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        write({ action: 'update', entityType: 'proxy_host', summary: `Parallel ${i}` }),
      ),
    );
    const rows = await chained();
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 25 });
  });

  it('chains several rows inside a caller transaction, and rolls back with it', async () => {
    await runInTransaction((tx) => [
      chainedAuditInsert(tx, [
        auditEventRow({ action: 'delete', entityType: 'certificate', entityId: 1 }),
        auditEventRow({ action: 'delete', entityType: 'certificate', entityId: 2 }),
      ]),
    ]);
    await expect(
      runInTransaction((tx) => [
        chainedAuditInsert(tx, [auditEventRow({ action: 'delete', entityType: 'certificate' })]),
        // Fails: no such user, so the audit row and the head move are undone with it.
        tx.insert(schema.groupMembers).values({ groupId: 999, userId: 999, createdAt: 'x' }),
      ]),
    ).rejects.toThrow();
    const [head] = await ctx.db.select().from(schema.auditChain);
    expect(head.headSeq).toBe(2);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 2 });
  });

  it('anchors at the oldest kept event when old events are pruned', async () => {
    await log(2, 'Old');
    await ctx.db.update(schema.auditEvents).set({ createdAt: '2020-01-01T00:00:00.000Z' });
    await log(2, 'New');
    expect(await pruneAuditEvents('2021-01-01T00:00:00.000Z')).toBe(2);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 2 });
    await log(1);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3 });
  });

  it('starts over cleanly when every event is removed and re-anchored', async () => {
    await log(3);
    await ctx.db.delete(schema.auditEvents);
    await reanchorAuditChain();
    await log(2);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 2 });
  });

  it('adopts events without hashes as history from before the chain', async () => {
    await ctx.db.insert(schema.auditEvents).values([
      { action: 'create', entityType: 'user', createdAt: '2025-01-01T00:00:00.000Z' },
      { action: 'update', entityType: 'user', createdAt: '2025-01-02T00:00:00.000Z' },
    ]);
    await reanchorAuditChain();
    await log(1);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 1, legacy: 2 });
  });
});

describe('upgrading to the chain', () => {
  it('marks every event already logged as predating it', async () => {
    const seeded = await createTestDbBefore('audit_chain');
    await seeded.exec(`INSERT INTO audit_events (action, "entityType", "createdAt")
      VALUES ('create', 'user', '2026-01-01T00:00:00.000Z'), ('update', 'user', '2026-01-02T00:00:00.000Z')`);
    await seeded.migrateRest();
    ctx.db = seeded.db;
    const [head] = await ctx.db.select().from(schema.auditChain);
    expect(head).toMatchObject({ headSeq: 0, headHash: GENESIS_HASH, legacyCount: 0, seal: null });
    expect((await verifyAuditChain()).firstBroken?.reason).toBe('unchained');
    // The startup step marks them, and says so in the chain.
    expect(await prepareAuditChain()).toBe('sealed');
    await log(2);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3, legacy: 2 });
    expect(await prepareAuditChain()).toBe('current');
  });

  it('re-keys a chain written before it was keyed', async () => {
    await log(2);
    // What the unkeyed chain stored: plain SHA-256 links and an unsealed head.
    let prev = GENESIS_HASH;
    for (const row of await chained()) {
      const hash = createHash('sha256')
        .update(prev)
        .update(canonicalAuditContent({ ...row, seq: row.seq as number }))
        .digest('hex');
      await ctx.db
        .update(schema.auditEvents)
        .set({ prevHash: prev, hash })
        .where(eq(schema.auditEvents.id, row.id));
      prev = hash;
    }
    await ctx.db.update(schema.auditChain).set({ headHash: prev, seal: null });
    expect((await verifyAuditChain()).ok).toBe(false);
    expect(await prepareAuditChain()).toBe('sealed');
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3 });
  });
});

type ChainRow = Awaited<ReturnType<typeof chained>>[number];

describe('the chain is keyed', () => {
  /** Rewrites an event's summary and hash the way a forger with database access would. */
  async function forge(
    seq: number,
    hashOf: (prev: string, row: ChainRow & { seq: number }) => string,
  ) {
    const rows = await chained();
    const row = rows.find((candidate) => candidate.seq === seq) as ChainRow;
    const hash = hashOf(row.prevHash as string, { ...row, summary: 'Forged', seq });
    await ctx.db
      .update(schema.auditEvents)
      .set({ summary: 'Forged', hash })
      .where(eq(schema.auditEvents.id, row.id));
    // The head moves with it, which an unkeyed chain could not tell from a real write.
    if (seq === rows.length) await ctx.db.update(schema.auditChain).set({ headHash: hash });
  }

  it('refuses an event re-hashed with plain SHA-256', async () => {
    await log(2);
    expect((await verifyAuditChain()).ok).toBe(true);
    await forge(2, (prev, row) =>
      createHash('sha256').update(prev).update(canonicalAuditContent(row)).digest('hex'),
    );
    expect((await verifyAuditChain()).firstBroken).toMatchObject({ reason: 'content', seq: 2 });
  });

  it('refuses an event re-hashed under another key', async () => {
    await log(2);
    const other = derivePurposeKey(
      'audit-chain:v1',
      'another-installation-secret-0123456789abcdef',
    );
    await forge(2, (prev, row) => auditEventHash(prev, row, other));
    expect((await verifyAuditChain()).firstBroken).toMatchObject({ reason: 'content', seq: 2 });
  });

  it('refuses a head moved back over removed events, then and after the next write', async () => {
    await log(3);
    const [, second] = await chained();
    await ctx.db.delete(schema.auditEvents).where(eq(schema.auditEvents.seq, 3));
    await ctx.db.update(schema.auditChain).set({ headSeq: 2, headHash: second.hash as string });
    expect((await verifyAuditChain()).firstBroken).toMatchObject({ reason: 'head' });
    await log(1);
    expect((await verifyAuditChain()).firstBroken).toMatchObject({ reason: 'head' });
  });

  it('reports an unchained event below the newest pre-chain id', async () => {
    await ctx.db.insert(schema.auditEvents).values([
      { id: 10, action: 'create', entityType: 'user', createdAt: '2025-01-01T00:00:00.000Z' },
      { id: 11, action: 'update', entityType: 'user', createdAt: '2025-01-02T00:00:00.000Z' },
    ]);
    await reanchorAuditChain();
    await log(1);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, legacy: 2 });
    const [marked] = await ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.id, 10));
    // A copied mark does not pass: it is bound to the event's id.
    await ctx.db.insert(schema.auditEvents).values({
      id: 5,
      action: 'create',
      entityType: 'user',
      createdAt: '2025-01-01T00:00:00.000Z',
      hash: marked.hash,
    });
    expect((await verifyAuditChain()).firstBroken).toEqual({
      reason: 'unchained',
      seq: null,
      eventId: 5,
    });
  });

  it('reports a pre-chain event edited, then removed', async () => {
    await ctx.db.insert(schema.auditEvents).values([
      { id: 10, action: 'create', entityType: 'user', createdAt: '2025-01-01T00:00:00.000Z' },
      { id: 11, action: 'update', entityType: 'user', createdAt: '2025-01-02T00:00:00.000Z' },
    ]);
    await reanchorAuditChain();
    await ctx.db
      .update(schema.auditEvents)
      .set({ summary: 'Edited' })
      .where(eq(schema.auditEvents.id, 11));
    expect((await verifyAuditChain()).firstBroken).toMatchObject({
      reason: 'unchained',
      eventId: 11,
    });
    await ctx.db.delete(schema.auditEvents).where(eq(schema.auditEvents.id, 11));
    expect((await verifyAuditChain()).firstBroken).toEqual({
      reason: 'legacy',
      seq: null,
      eventId: null,
    });
  });
});

describe('rotating SESSION_SECRET', () => {
  const NEXT = 'the-rotated-session-secret-0123456789abcdef';

  it('re-keys the chain once it verifies under the previous secret', async () => {
    await log(2);
    const old = config.sessionSecret;
    expect(await prepareAuditChain(old, [])).toBe('current');
    expect(await prepareAuditChain(NEXT, [old])).toBe('rekeyed');
    expect(await verifyAuditChain(NEXT)).toMatchObject({ ok: true, checked: 3 });
    expect((await chained())[2]).toMatchObject({
      action: 'audit_rekeyed',
      entityType: 'audit_log',
    });
    expect((await verifyAuditChain(old)).ok).toBe(false);
    expect(await prepareAuditChain(NEXT, [old])).toBe('current');
  });

  it('does not re-key an altered chain', async () => {
    await log(2);
    const [first] = await chained();
    await ctx.db
      .update(schema.auditEvents)
      .set({ summary: 'Forged' })
      .where(eq(schema.auditEvents.id, first.id));
    const before = await chained();
    expect(await prepareAuditChain(NEXT, [config.sessionSecret])).toBe('unverified');
    expect(await chained()).toEqual(before);
  });

  it('leaves a chain no previous secret seals as it was', async () => {
    await log(1);
    expect(await prepareAuditChain(NEXT, [])).toBe('unverified');
    expect((await verifyAuditChain(NEXT)).ok).toBe(false);
  });
});
