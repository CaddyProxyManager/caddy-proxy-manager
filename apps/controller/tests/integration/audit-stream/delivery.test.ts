/**
 * Audit sinks against receivers started here: syslog over UDP, TCP and TLS, HTTP with each
 * encoding, and the file. Records arrive in `seq` order, at least once, from where the last pass
 * stopped; a receiver can rebuild and verify the chain; pruning past a sink leaves a gap it is told
 * about.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestCa } from '@/tests/helpers/certs';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq, gt } from 'drizzle-orm';
import {
  alertEvents,
  alertRules,
  auditChain,
  auditEvents,
  auditSinks,
  notificationChannels,
} from '../../../src/lib/db/schema';
import { type AuditEventParams, auditEventRow, insertAuditRows } from '../../../src/lib/audit';
import {
  auditEventHash,
  GENESIS_HASH,
  pruneAuditEvents,
  verifyAuditChain,
} from '../../../src/lib/audit/chain';
import { runAuditRetention } from '../../../src/lib/audit/retention';
import { createSink, deliverSink, testSink, updateSink } from '../../../src/lib/audit-stream';
import type { StreamRecord } from '../../../src/lib/audit-stream/records';
import {
  auditStreamDirectory,
  setResolverForTests,
} from '../../../src/lib/audit-stream/transports';
import { resetNotificationsForTests } from '../../../src/lib/notifications';
import { encryptSecret } from '../../../src/lib/secrets';
import { invalidateSettingsCache, saveSettings } from '../../../src/lib/settings/resolve';

// ── Receivers ────────────────────────────────────────────────────────────────

const ca = createTestCa();
const leaf = ca.issue('syslog.test');

let datagrams: string[] = [];
let streamBytes = Buffer.alloc(0);
let tlsBytes = Buffer.alloc(0);
let tlsConnections = 0;
type Hit = { headers: Record<string, string>; body: string };
let hits: Hit[] = [];
/** Statuses the HTTP receiver answers with, used up in order; then 200. */
let answers: number[] = [];
/** Answer 415 to any compressed body. */
let refuseCompressed = false;

let udp: Bun.udp.Socket<'buffer'>;
let tcp: Bun.TCPSocketListener;
let tls: Bun.TCPSocketListener;
let http: ReturnType<typeof Bun.serve>;
let dataDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cpm-audit-stream-'));
  process.env.L4_PORTS_DIR = dataDir;
  udp = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      data(_socket, data) {
        datagrams.push(data.toString('utf8'));
      },
    },
  });
  tcp = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(_socket, data) {
        streamBytes = Buffer.concat([streamBytes, data]);
      },
    },
  });
  tls = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: leaf.certificatePem, key: leaf.privateKeyPem },
    socket: {
      open() {
        tlsConnections += 1;
      },
      data(_socket, data) {
        tlsBytes = Buffer.concat([tlsBytes, data]);
      },
    },
  });
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const encoding = request.headers.get('content-encoding');
      if (refuseCompressed && encoding) return new Response('', { status: 415 });
      const raw = new Uint8Array(await request.arrayBuffer());
      const body =
        encoding === 'gzip'
          ? Bun.gunzipSync(raw)
          : encoding === 'zstd'
            ? Bun.zstdDecompressSync(raw)
            : raw;
      hits.push({
        headers: Object.fromEntries(request.headers),
        body: new TextDecoder().decode(body),
      });
      return new Response('', { status: answers.shift() ?? 200 });
    },
  });
  // Every name is this machine, as a receiver's DNS name would be on the operator's network.
  setResolverForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
});

afterAll(async () => {
  udp.close();
  tcp.stop(true);
  tls.stop(true);
  http.stop(true);
  setResolverForTests(null);
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  ctx.db = await createTestDb();
  datagrams = [];
  streamBytes = Buffer.alloc(0);
  tlsBytes = Buffer.alloc(0);
  tlsConnections = 0;
  hits = [];
  answers = [];
  refuseCompressed = false;
  invalidateSettingsCache();
  await resetNotificationsForTests();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// What logAuditEvent does, which the preload replaces with a mock for every other suite.
const logAuditEvent = (params: AuditEventParams) => insertAuditRows([auditEventRow(params)]);

async function events(count: number, label = 'event'): Promise<void> {
  for (let i = 0; i < count; i++) {
    await logAuditEvent({
      userId: null,
      action: 'update',
      entityType: 'test_entity',
      entityId: i,
      summary: `${label} ${i}`,
      data: { i, note: 'quote " backslash \\ bracket ]' },
    });
  }
}

/** Splits octet-counted frames. */
function unframe(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const space = bytes.indexOf(0x20, offset);
    const length = Number(bytes.subarray(offset, space).toString('ascii'));
    out.push(bytes.subarray(space + 1, space + 1 + length).toString('utf8'));
    offset = space + 1 + length;
  }
  return out;
}

/** The JSON after the structured data of an RFC 5424 message. */
function msgOf(message: string): StreamRecord {
  const sd = message.indexOf(' [cpm@');
  const end = message.indexOf('] ', sd);
  return JSON.parse(message.slice(end + 2));
}

const lines = (text: string): StreamRecord[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

async function sinkRow(id: number) {
  const [row] = await ctx.db.select().from(auditSinks).where(eq(auditSinks.id, id));
  return row;
}

async function headSeq(): Promise<number> {
  const rows = await ctx.db.select({ seq: auditEvents.seq }).from(auditEvents);
  return Math.max(0, ...rows.map((row) => row.seq ?? 0));
}

/** A receiver's check: every link follows the one before, and every hash recomputes. */
function verifyChain(records: StreamRecord[]): { ok: boolean; checked: number } {
  let prev: string | null = null;
  let checked = 0;
  for (const record of records) {
    if (record.kind === 'gap') {
      prev = null;
      continue;
    }
    if (record.kind !== 'audit') continue;
    if (prev !== null && record.prevHash !== prev) return { ok: false, checked };
    const { kind: _k, v: _v, prevHash, hash, ...content } = record;
    if (auditEventHash(prevHash, content) !== hash) return { ok: false, checked };
    prev = hash;
    checked += 1;
  }
  return { ok: true, checked };
}

function seqs(records: StreamRecord[]): number[] {
  return records.flatMap((record) => (record.kind === 'audit' ? [record.seq] : []));
}

let names = 0;
const name = (kind: string) => `${kind}-${++names}`;

// ── Transports ───────────────────────────────────────────────────────────────

describe('syslog transports', () => {
  it('sends one RFC 5424 datagram per record over UDP', async () => {
    await events(3);
    const sink = await createSink(
      { name: name('udp'), kind: 'syslog-udp', host: 'logs.test', port: udp.port },
      null,
    );
    expect(await deliverSink(sink.id)).toBe('delivered');
    await vi.waitFor(() => expect(datagrams.length).toBe(sink.auditLag));
    expect(
      datagrams.every((line) => /^<109>1 \S+ \S+ cpm - audit \[cpm@32473 seq="/.test(line)),
    ).toBe(true);
    const records = datagrams.map(msgOf);
    expect(seqs(records)).toEqual([...seqs(records)].sort((a, b) => a - b));
    expect(verifyChain(records).ok).toBe(true);
  });

  it('cuts a UDP datagram at the sink maximum without losing the chain fields', async () => {
    await logAuditEvent({
      action: 'update',
      entityType: 'test_entity',
      summary: 'big',
      data: { blob: 'y'.repeat(4000) },
    });
    const sink = await createSink(
      {
        name: name('udp-small'),
        kind: 'syslog-udp',
        host: 'logs.test',
        port: udp.port,
        maxBytes: 600,
      },
      null,
    );
    await deliverSink(sink.id);
    await vi.waitFor(() => expect(datagrams.length).toBeGreaterThan(0));
    const big = datagrams.find((line) => line.includes('truncated='));
    expect(big).toBeDefined();
    expect(Buffer.byteLength(big as string)).toBeLessThanOrEqual(600);
    expect(big).toMatch(/seq="\d+" prevHash="[0-9a-f]{64}" hash="[0-9a-f]{64}" truncated="\d+"/);
  });

  it('sends octet-counted frames over TCP', async () => {
    await events(2);
    const sink = await createSink(
      { name: name('tcp'), kind: 'syslog-tcp', host: 'logs.test', port: tcp.port },
      null,
    );
    expect(await deliverSink(sink.id)).toBe('delivered');
    await vi.waitFor(() => expect(unframe(streamBytes).length).toBe(sink.auditLag));
    const records = unframe(streamBytes).map(msgOf);
    expect(verifyChain(records)).toEqual({ ok: true, checked: sink.auditLag });
  });

  it('sends over TLS once the certificate checks out for the host name', async () => {
    await events(2);
    const sink = await createSink(
      {
        name: name('tls'),
        kind: 'syslog-tls',
        host: 'syslog.test',
        port: tls.port,
        ca: ca.certificatePem,
      },
      null,
    );
    expect(await deliverSink(sink.id)).toBe('delivered');
    await vi.waitFor(() => expect(unframe(tlsBytes).length).toBe(sink.auditLag));
    expect(verifyChain(unframe(tlsBytes).map(msgOf)).ok).toBe(true);
  });

  it('writes nothing over TLS when the certificate is for another name', async () => {
    await events(1);
    const sink = await createSink(
      {
        name: name('tls-wrong'),
        kind: 'syslog-tls',
        host: 'other.test',
        port: tls.port,
        ca: ca.certificatePem,
      },
      null,
    );
    expect(await deliverSink(sink.id)).toBe('failed');
    await Bun.sleep(200);
    expect(tlsConnections).toBeGreaterThan(0);
    expect(tlsBytes.length).toBe(0);
    const row = await sinkRow(sink.id);
    expect(row.auditCursor).toBe(sink.auditCursor);
    expect(row.lastErrorCode).toContain('auditSinkTls');
    expect(row.lastError).toContain('other.test');
  });

  it('writes nothing over TLS to a certificate from an untrusted CA', async () => {
    await events(1);
    const sink = await createSink(
      { name: name('tls-untrusted'), kind: 'syslog-tls', host: 'syslog.test', port: tls.port },
      null,
    );
    expect(await deliverSink(sink.id)).toBe('failed');
    await Bun.sleep(200);
    expect(tlsBytes.length).toBe(0);
  });
});

describe('HTTP and file sinks', () => {
  for (const encoding of ['identity', 'gzip', 'zstd'] as const) {
    it(`posts NDJSON with ${encoding} encoding and the auth header`, async () => {
      await events(2);
      const sink = await createSink(
        {
          name: name(`http-${encoding}`),
          kind: 'http',
          url: `http://127.0.0.1:${http.port}/ingest?token=abc`,
          encoding,
          headerName: 'Authorization',
          headerValue: 'Bearer s3cret',
        },
        null,
      );
      expect(sink.target).toBe(`http://127.0.0.1:${http.port}/…`);
      expect(await deliverSink(sink.id)).toBe('delivered');
      expect(hits).toHaveLength(1);
      expect(hits[0].headers['content-type']).toBe('application/x-ndjson');
      expect(hits[0].headers['content-encoding'] ?? 'identity').toBe(encoding);
      expect(hits[0].headers.authorization).toBe('Bearer s3cret');
      const records = lines(hits[0].body);
      expect(records).toHaveLength(sink.auditLag);
      expect(verifyChain(records).ok).toBe(true);
    });
  }

  it('falls back to identity on a 415, says so, and keeps sending uncompressed', async () => {
    await events(1);
    refuseCompressed = true;
    const sink = await createSink(
      {
        name: name('http-415'),
        kind: 'http',
        url: `http://127.0.0.1:${http.port}/`,
        encoding: 'zstd',
      },
      null,
    );
    expect(await deliverSink(sink.id)).toBe('delivered');
    expect(hits).toHaveLength(1);
    expect(hits[0].headers['content-encoding']).toBeUndefined();
    expect((await sinkRow(sink.id)).encodingFallback).toBe(true);
    await events(1);
    await deliverSink(sink.id);
    expect(hits).toHaveLength(2);
    expect(hits[1].headers['content-encoding']).toBeUndefined();
    // Saving the sink again tries the configured encoding afresh.
    await updateSink(sink.id, { name: sink.name, kind: 'http', url: '', encoding: 'zstd' }, null);
    expect((await sinkRow(sink.id)).encodingFallback).toBe(false);
  });

  it('appends JSON lines to a file on the data volume', async () => {
    await events(2);
    const sink = await createSink(
      { name: name('file'), kind: 'file', fileName: 'siem.jsonl' },
      null,
    );
    await deliverSink(sink.id);
    await events(1, 'later');
    await deliverSink(sink.id);
    const records = lines(await readFile(join(auditStreamDirectory(), 'siem.jsonl'), 'utf8'));
    expect(records.length).toBe(sink.auditLag + 1);
    expect(seqs(records)).toEqual([...new Set(seqs(records))].sort((a, b) => a - b));
    expect(verifyChain(records).ok).toBe(true);
  });

  it('sends a test record to a saved sink or a form as typed', async () => {
    const sink = await createSink(
      { name: name('http-test'), kind: 'http', url: `http://127.0.0.1:${http.port}/` },
      null,
    );
    await testSink(sink.id, null);
    await testSink(null, { name: 'unsaved', kind: 'http', url: `http://127.0.0.1:${http.port}/x` });
    expect(hits.map((hit) => lines(hit.body)[0].kind)).toEqual(['test', 'test']);
    answers = [503];
    const refused = await testSink(sink.id, null).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refused).toContain('HTTP 503');
  });
});

// ── Cursor ───────────────────────────────────────────────────────────────────

describe('the cursor', () => {
  it('delivers in seq order, at least once, and resumes where it stopped', async () => {
    const sink = await createSink(
      { name: name('cursor'), kind: 'http', url: `http://127.0.0.1:${http.port}/` },
      null,
    );
    await events(450);
    expect(await deliverSink(sink.id)).toBe('delivered');
    // Batches of 200, each its own request, in order.
    expect(hits.map((hit) => lines(hit.body).length)).toEqual([200, 200, sink.auditLag + 50]);
    const first = hits.flatMap((hit) => lines(hit.body));
    expect((await sinkRow(sink.id)).auditCursor).toBe(await headSeq());

    // The receiver takes the next batch but answers 500: it comes again, whole and in order.
    hits = [];
    await events(5, 'retry');
    answers = [500];
    expect(await deliverSink(sink.id)).toBe('failed');
    const failed = await sinkRow(sink.id);
    expect(failed.failures).toBe(1);
    expect(failed.retryAt).not.toBeNull();
    expect(failed.lastErrorCode).toContain('auditSinkHttpStatus');
    // Backing off: nothing until retryAt.
    expect(await deliverSink(sink.id)).toBe('skipped');
    // A restart reads everything from the row, so a later pass is the same as a new process.
    expect(await deliverSink(sink.id, Date.now() + 10 * 60_000)).toBe('delivered');
    expect(hits).toHaveLength(2);
    expect(hits[1].body).toBe(hits[0].body);
    const after = await sinkRow(sink.id);
    expect(after.failures).toBe(0);
    expect(after.lastError).toBeNull();

    const all = [...first, ...lines(hits[1].body)];
    const delivered = seqs(all);
    expect(delivered).toEqual([...delivered].sort((a, b) => a - b));
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(verifyChain(all)).toEqual({ ok: true, checked: delivered.length });
  });

  it('lets only the replica holding the lease send', async () => {
    await events(1);
    const sink = await createSink(
      { name: name('lease'), kind: 'http', url: `http://127.0.0.1:${http.port}/` },
      null,
    );
    await ctx.db
      .update(auditSinks)
      .set({
        leaseOwner: 'another-replica',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(auditSinks.id, sink.id));
    expect(await deliverSink(sink.id)).toBe('skipped');
    expect(hits).toHaveLength(0);
    // Once that lease runs out, it is this replica's.
    expect(await deliverSink(sink.id, Date.now() + 120_000)).toBe('delivered');
    expect(hits).toHaveLength(1);
    expect((await sinkRow(sink.id)).leaseOwner).toBeNull();
  });
});

// ── Pruning ──────────────────────────────────────────────────────────────────

describe('pruning past a slow sink', () => {
  it('sends a gap record, records the gap, and raises an alert', async () => {
    const at = new Date().toISOString();
    const [channel] = await ctx.db
      .insert(notificationChannels)
      .values({
        name: 'audit-hook',
        kind: 'webhook',
        secret: encryptSecret(JSON.stringify({ url: `http://127.0.0.1:${http.port}/alerts` })),
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    await ctx.db.insert(alertRules).values({
      name: 'sinks',
      source: 'event',
      sourceConfig: JSON.stringify({ kinds: ['auditSinkFailed'] }),
      severity: 'critical',
      channelIds: JSON.stringify([channel.id]),
      createdAt: at,
      updatedAt: at,
    });

    const sink = await createSink(
      { name: name('slow'), kind: 'file', fileName: 'slow.jsonl' },
      null,
    );
    await deliverSink(sink.id);
    const caughtUp = (await sinkRow(sink.id)).auditCursor;
    await events(4, 'pruned');
    // Retention takes everything before now, the four this sink never received among them.
    expect(await pruneAuditEvents(new Date(Date.now() + 1000).toISOString())).toBeGreaterThan(0);
    const [{ anchorSeq: pruned }] = await ctx.db.select().from(auditChain);
    expect(pruned).toBeGreaterThan(caughtUp);
    await events(1, 'kept');
    expect(await deliverSink(sink.id)).toBe('delivered');

    const records = lines(await readFile(join(auditStreamDirectory(), 'slow.jsonl'), 'utf8'));
    const gap = records.find((record) => record.kind === 'gap');
    expect(gap).toMatchObject({ kind: 'gap', stream: 'audit', from: caughtUp + 1, to: pruned });
    const kept = records.at(-1);
    expect(kept).toMatchObject({ kind: 'audit', summary: 'kept 0' });
    // The chain carries on from the last event pruned, which the receiver never saw.
    expect(kept && kept.kind === 'audit' && kept.prevHash).not.toBe(GENESIS_HASH);

    const row = await sinkRow(sink.id);
    expect(row).toMatchObject({ gapStream: 'audit', gapFrom: caughtUp + 1, gapTo: pruned });
    expect(row.missed).toBe(pruned - caughtUp);
    const told = await ctx.db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.kind, 'auditSinkFailed'));
    expect(told).toHaveLength(1);
    expect(JSON.parse(told[0].event)).toMatchObject({
      sink: sink.name,
      errorCode: { code: 'auditSinkGapAudit', params: { from: caughtUp + 1, to: pruned } },
    });
  });

  it('tells a sink of the retention job removals as a gap, and the chain carries on', async () => {
    const at = new Date().toISOString();
    const [channel] = await ctx.db
      .insert(notificationChannels)
      .values({
        name: 'retention-hook',
        kind: 'webhook',
        secret: encryptSecret(JSON.stringify({ url: `http://127.0.0.1:${http.port}/alerts` })),
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    await ctx.db.insert(alertRules).values({
      name: 'retention',
      source: 'event',
      sourceConfig: JSON.stringify({ kinds: ['auditSinkFailed'] }),
      severity: 'critical',
      channelIds: JSON.stringify([channel.id]),
      createdAt: at,
      updatedAt: at,
    });
    const sink = await createSink(
      { name: name('retained'), kind: 'file', fileName: 'retained.jsonl' },
      null,
    );
    await deliverSink(sink.id);
    const caughtUp = (await sinkRow(sink.id)).auditCursor;
    await events(3, 'aged');
    await ctx.db
      .update(auditEvents)
      .set({ createdAt: '2020-01-01T00:00:00.000Z' })
      .where(gt(auditEvents.seq, caughtUp));
    await saveSettings({ 'config:audit_log_keep_days': 30 });
    invalidateSettingsCache();

    expect((await runAuditRetention())?.deleted).toBe(3);
    const [{ anchorSeq: pruned }] = await ctx.db.select().from(auditChain);
    expect(pruned).toBe(caughtUp + 3);
    expect(await deliverSink(sink.id)).toBe('delivered');

    const records = lines(await readFile(join(auditStreamDirectory(), 'retained.jsonl'), 'utf8'));
    const gapAt = records.findIndex((record) => record.kind === 'gap');
    expect(records[gapAt]).toMatchObject({ stream: 'audit', from: caughtUp + 1, to: pruned });
    // The removal's own record follows the gap and links to the last event it removed.
    expect(records[gapAt + 1]).toMatchObject({ kind: 'audit', action: 'audit_pruned' });
    expect(verifyChain(records.slice(gapAt))).toEqual({ ok: true, checked: 1 });
    expect(await verifyAuditChain()).toMatchObject({ ok: true });

    expect(await sinkRow(sink.id)).toMatchObject({
      gapStream: 'audit',
      gapFrom: caughtUp + 1,
      gapTo: pruned,
      missed: 3,
    });
    const told = await ctx.db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.kind, 'auditSinkFailed'));
    expect(told.map((event) => JSON.parse(event.event).errorCode)).toEqual([
      { code: 'auditSinkGapAudit', params: { from: caughtUp + 1, to: pruned } },
    ]);
  });

  it('raises a failing sink after repeated failures and resolves it when it catches up', async () => {
    const sink = await createSink(
      { name: name('failing'), kind: 'http', url: `http://127.0.0.1:${http.port}/` },
      null,
    );
    const at = new Date().toISOString();
    const [channel] = await ctx.db
      .insert(notificationChannels)
      .values({
        name: `hook-${sink.id}`,
        kind: 'webhook',
        secret: encryptSecret(JSON.stringify({ url: `http://127.0.0.1:${http.port}/alerts` })),
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    await ctx.db.insert(alertRules).values({
      name: `failing-${sink.id}`,
      source: 'event',
      sourceConfig: JSON.stringify({ kinds: ['auditSinkFailed', 'auditSinkRecovered'] }),
      severity: 'critical',
      channelIds: JSON.stringify([channel.id]),
      createdAt: at,
      updatedAt: at,
    });
    await events(1);
    let now = Date.now();
    for (let i = 0; i < 3; i++) {
      answers = [500];
      expect(await deliverSink(sink.id, now)).toBe('failed');
      now += 10 * 60_000;
    }
    const raised = await ctx.db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.key, `audit-sink:${sink.id}`));
    expect(raised.map((row) => row.kind)).toEqual(['auditSinkFailed']);
    expect(await deliverSink(sink.id, now)).toBe('delivered');
    const [after] = await ctx.db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.key, `audit-sink:${sink.id}`));
    // Resolved; a recovery is only told where the problem itself was sent.
    expect(after.resolvedAt).not.toBeNull();
  });
});
