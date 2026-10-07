/**
 * The per-sink "Include security events" switch: off, nothing is even queued; on, WAF events and
 * other mitigated requests go out as `kind: "security"` with a cursor of their own, outside the
 * chain, credentials redacted as stored. The queue never waits for a slow sink.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('@/tests/helpers/db');
vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

// Analytics on, with nowhere to write: the queue is what is under test.
vi.mock('@/src/lib/clickhouse/client', () => ({
  isAnalyticsEnabled: async () => true,
  insertTrafficEvents: async () => {},
  insertWafEvents: async () => {},
}));

const { ingestAnalytics } = await import('@/src/lib/agent/analytics-ingest');
const { auditEventRow, insertAuditRows } = await import('@/src/lib/audit');
const { createSink, deliverSink, updateSink } = await import('@/src/lib/audit-stream');
const { pruneSecurityRecords, SECURITY_KEEP_MS } = await import('@/src/lib/audit-stream/security');
const { auditStreamDirectory } = await import('@/src/lib/audit-stream/transports');
const { auditSecurityHead, auditSecurityRecords, auditSinks } = await import('@/src/lib/db/schema');
const { eq } = await import('drizzle-orm');

let dataDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cpm-audit-security-'));
  process.env.L4_PORTS_DIR = dataDir;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  ctx.db = await createTestDb();
});

const NOW = Math.floor(Date.now() / 1000);

const waf = (uri: string) => ({
  ts: NOW,
  host: 'shop.example',
  client_ip: '203.0.113.9',
  country_code: 'DE',
  rule_id: 942100,
  rule_message: 'SQL injection',
  severity: 'critical',
  raw_data: null,
  blocked: true,
  method: 'POST',
  uri,
});

const request = (uri: string, outcome: string) => ({
  ts: NOW,
  client_ip: '198.51.100.7',
  country_code: null,
  host: 'shop.example',
  method: 'GET',
  uri,
  status: outcome === 'served' ? 200 : 403,
  proto: 'HTTP/2.0',
  bytes_sent: 10,
  user_agent: 'curl/8',
  is_blocked: outcome !== 'served',
  outcome,
});

async function relay() {
  await ingestAnalytics('agent-1', 'waf', [waf('/login?password=hunter2&next=/')], 1);
  await ingestAnalytics(
    'agent-1',
    'traffic',
    [request('/ok', 'served'), request('/admin?token=abc123&page=2', 'geo')],
    1,
  );
}

async function fileLines(fileName: string) {
  try {
    return (await readFile(join(auditStreamDirectory(), fileName), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe('security events on a sink', () => {
  it('off: none are queued or sent', async () => {
    await insertAuditRows([auditEventRow({ action: 'update', entityType: 'thing' })]);
    const sink = await createSink({ name: 'plain', kind: 'file', fileName: 'plain.jsonl' }, null);
    await relay();
    expect(await ctx.db.select().from(auditSecurityRecords)).toHaveLength(0);
    await deliverSink(sink.id);
    const records = await fileLines('plain.jsonl');
    expect(records.map((record) => record.kind)).toEqual(['audit']);
  });

  it('on: sent as kind security with their own seq, redacted, and outside the chain', async () => {
    await insertAuditRows([auditEventRow({ action: 'update', entityType: 'thing' })]);
    const sink = await createSink(
      { name: 'siem', kind: 'file', fileName: 'siem.jsonl', includeSecurity: true },
      null,
    );
    await relay();
    await deliverSink(sink.id);
    const records = await fileLines('siem.jsonl');
    const security = records.filter((record) => record.kind === 'security');
    expect(security).toHaveLength(2);
    expect(security.map((record) => record.seq)).toEqual([1, 2]);
    for (const record of security) {
      expect(record.chained).toBe(false);
      expect(record.hash).toBeUndefined();
      expect(record.prevHash).toBeUndefined();
    }
    const [wafRecord, mitigated] = security;
    expect(wafRecord).toMatchObject({ type: 'waf', ruleId: 942100, blocked: true });
    expect(wafRecord.uri).not.toContain('hunter2');
    expect(mitigated).toMatchObject({ type: 'mitigated', outcome: 'geo', status: 403 });
    expect(mitigated.uri).not.toContain('abc123');
    expect(mitigated.uri).toContain('page=2');

    // The audit stream's cursor and the security stream's move apart.
    const row = (await ctx.db.select().from(auditSinks).where(eq(auditSinks.id, sink.id)))[0];
    expect(row.securityCursor).toBe(2);
    expect(row.auditCursor).toBe(1);
    // Every sink that takes them has them, so the queue lets them go.
    await pruneSecurityRecords();
    expect(await ctx.db.select().from(auditSecurityRecords)).toHaveLength(0);
  });

  it('switched on later: from then on, not from the start of the queue', async () => {
    const taker = await createSink(
      { name: 'taker', kind: 'file', fileName: 'taker.jsonl', includeSecurity: true },
      null,
    );
    await relay();
    const later = await createSink({ name: 'later', kind: 'file', fileName: 'later.jsonl' }, null);
    await updateSink(
      later.id,
      { name: 'later', kind: 'file', fileName: 'later.jsonl', includeSecurity: true },
      null,
    );
    await relay();
    await deliverSink(taker.id);
    await deliverSink(later.id);
    const seqsOf = async (file: string) =>
      (await fileLines(file)).filter((r) => r.kind === 'security').map((r) => r.seq);
    expect(await seqsOf('taker.jsonl')).toEqual([1, 2, 3, 4]);
    expect(await seqsOf('later.jsonl')).toEqual([3, 4]);
  });

  it('records the gap when the queue drops what a slow sink had not taken', async () => {
    const sink = await createSink(
      { name: 'slow', kind: 'file', fileName: 'slow.jsonl', includeSecurity: true },
      null,
    );
    await relay();
    // A day later, the two queued records are past what the queue keeps.
    await pruneSecurityRecords(Date.now() + SECURITY_KEEP_MS + 60_000);
    const [head] = await ctx.db.select().from(auditSecurityHead);
    expect(head.prunedSeq).toBe(2);
    await relay();
    await deliverSink(sink.id);
    const records = (await fileLines('slow.jsonl')).filter((record) => record.kind !== 'audit');
    expect(records[0]).toMatchObject({ kind: 'gap', stream: 'security', from: 1, to: 2 });
    expect(records.slice(1).map((record) => record.seq)).toEqual([3, 4]);
    const row = (await ctx.db.select().from(auditSinks).where(eq(auditSinks.id, sink.id)))[0];
    expect(row).toMatchObject({ gapStream: 'security', gapFrom: 1, gapTo: 2, missed: 2 });
  });
});
