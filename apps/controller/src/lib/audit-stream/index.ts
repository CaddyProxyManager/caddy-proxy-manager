/**
 * Streams the audit log to its sinks. The leader, every few seconds, sends each enabled sink what
 * lies past its cursor in `seq` order and moves the cursor only once a batch is through, so
 * delivery is at least once and survives a restart. A lease on the sink's row keeps a replica that
 * just lost the lead from sending alongside the next one, and a cursor write needs the lease, so a
 * pass that outlived it cannot move the cursor back. Pruning never waits for a sink: one left
 * behind it is sent a gap record, records the gap, and raises an alert.
 */

import { and, asc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import { cluster } from "../cluster/state";
import db, { nowIso } from "../db";
import { auditEvents, auditSinks } from "../db/schema";
import {
  type DomainError,
  domainError,
  domainErrorOf,
  type StoredErrorCode,
} from "../errors/domain-error";
import { notify, raiseProblem, resolveProblem } from "../notifications";
import { type GapRecord, type StreamRecord, auditRecord, gapRecord, testRecord } from "./records";
import { pruneSecurityRecords, readSecurityRecords, securityHead } from "./security";
import {
  PROBLEM_PREFIX,
  type Sink,
  type SinkInput,
  getSink,
  parseSink,
  previewSink,
  streamHeads,
} from "./sinks";
import { sendRecords } from "./transports";

export const TICK_MS = 5_000;
export const BATCH = 200;
/** Batches per stream per pass, so one sink catching up cannot hold the rest for long. */
const MAX_BATCHES = 25;
const LEASE_MS = 60_000;
/** Failed passes in a row before an alert: a receiver restarting is not worth one. */
export const FAILURES_BEFORE_ALERT = 3;
const MAX_BACKOFF_MS = 5 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

class LeaseLost extends Error {}

function me(): string {
  return cluster.replicaId;
}

/** The sink, leased to this replica; null when another holds it, it is off, or it is backing off. */
async function claim(id: number, now: number): Promise<Sink | null> {
  const at = iso(now);
  const [row] = await db
    .update(auditSinks)
    .set({ leaseOwner: me(), leaseUntil: iso(now + LEASE_MS) })
    .where(
      and(
        eq(auditSinks.id, id),
        eq(auditSinks.enabled, true),
        or(isNull(auditSinks.retryAt), lte(auditSinks.retryAt, at)),
        or(
          isNull(auditSinks.leaseUntil),
          lt(auditSinks.leaseUntil, at),
          eq(auditSinks.leaseOwner, me()),
        ),
      ),
    )
    .returning();
  return row ? parseSink(row) : null;
}

/** Writes `fields` and renews the lease, or throws LeaseLost when another replica took it. */
async function advance(sink: Sink, fields: Partial<typeof auditSinks.$inferInsert>) {
  const rows = await db
    .update(auditSinks)
    .set({ ...fields, leaseUntil: iso(Date.now() + LEASE_MS) })
    .where(and(eq(auditSinks.id, sink.id), eq(auditSinks.leaseOwner, me())))
    .returning({ id: auditSinks.id });
  if (rows.length === 0) throw new LeaseLost();
}

async function release(sink: Sink): Promise<void> {
  await db
    .update(auditSinks)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(and(eq(auditSinks.id, sink.id), eq(auditSinks.leaseOwner, me())));
}

function stored(error: DomainError): StoredErrorCode {
  return { code: error.code, params: error.params };
}

function hooksFor(sink: Sink) {
  return {
    async onEncodingRefused() {
      sink.encodingFallback = true;
      await advance(sink, { encodingFallback: true });
    },
  };
}

async function reportGap(sink: Sink, gap: GapRecord): Promise<void> {
  const error = domainError(gap.stream === "audit" ? "auditSinkGapAudit" : "auditSinkGapSecurity", {
    from: gap.from,
    to: gap.to,
  });
  await notify(`${PROBLEM_PREFIX}gap:${sink.id}:${gap.stream}:${gap.from}`, {
    kind: "auditSinkFailed",
    sink: sink.name,
    error: error.message,
    errorCode: stored(error),
  });
}

function gapFields(gap: GapRecord, missed: number) {
  return {
    gapStream: gap.stream,
    gapFrom: gap.from,
    gapTo: gap.to,
    gapAt: gap.createdAt,
    missed,
  };
}

async function streamAudit(sink: Sink): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const heads = await streamHeads();
    // Behind the head after a restore brought back an older log: what follows is new again.
    let cursor = Math.min(sink.auditCursor, heads.audit);
    const records: StreamRecord[] = [];
    let gap: GapRecord | null = null;
    if (cursor < heads.auditAnchor) {
      gap = gapRecord("audit", cursor + 1, heads.auditAnchor, nowIso());
      records.push(gap);
      cursor = heads.auditAnchor;
    }
    const rows = await db
      .select()
      .from(auditEvents)
      .where(gt(auditEvents.seq, cursor))
      .orderBy(asc(auditEvents.seq))
      .limit(BATCH);
    records.push(...rows.map(auditRecord));
    const next = rows.at(-1)?.seq ?? cursor;
    if (records.length === 0) {
      if (next !== sink.auditCursor) await advance(sink, { auditCursor: next });
      sink.auditCursor = next;
      return;
    }
    await sendRecords(sink, records, hooksFor(sink));
    const missed = gap ? sink.missed + (gap.to - gap.from + 1) : sink.missed;
    await advance(sink, {
      auditCursor: next as number,
      lastDeliveredAt: nowIso(),
      ...(gap ? gapFields(gap, missed) : {}),
    });
    sink.auditCursor = next as number;
    sink.missed = missed;
    if (gap) await reportGap(sink, gap);
    if (rows.length < BATCH) return;
  }
}

async function streamSecurity(sink: Sink): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const head = await securityHead();
    let cursor = Math.min(sink.securityCursor, head.headSeq);
    const records: StreamRecord[] = [];
    let gap: GapRecord | null = null;
    if (cursor < head.prunedSeq) {
      gap = gapRecord("security", cursor + 1, head.prunedSeq, nowIso());
      records.push(gap);
      cursor = head.prunedSeq;
    }
    const rows = await readSecurityRecords(cursor, BATCH);
    records.push(...rows);
    const next = rows.at(-1)?.seq ?? cursor;
    if (records.length === 0) {
      if (next !== sink.securityCursor) await advance(sink, { securityCursor: next });
      sink.securityCursor = next;
      return;
    }
    await sendRecords(sink, records, hooksFor(sink));
    const missed = gap ? sink.missed + (gap.to - gap.from + 1) : sink.missed;
    await advance(sink, {
      securityCursor: next,
      lastDeliveredAt: nowIso(),
      ...(gap ? gapFields(gap, missed) : {}),
    });
    sink.securityCursor = next;
    sink.missed = missed;
    if (gap) await reportGap(sink, gap);
    if (rows.length < BATCH) return;
  }
}

function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, TICK_MS * 2 ** Math.max(0, failures - 1));
}

export type PassResult = "skipped" | "delivered" | "failed";

/** One pass for one sink: everything it is owed, up to the per-pass budget. */
export async function deliverSink(id: number, now = Date.now()): Promise<PassResult> {
  const sink = await claim(id, now);
  if (!sink) return "skipped";
  const problemKey = `${PROBLEM_PREFIX}${sink.id}`;
  try {
    await streamAudit(sink);
    if (sink.includeSecurity) await streamSecurity(sink);
    if (sink.failures > 0 || sink.lastError) {
      await advance(sink, {
        failures: 0,
        retryAt: null,
        lastError: null,
        lastErrorAt: null,
        lastErrorCode: null,
      });
      const name = sink.name;
      await resolveProblem(problemKey, (raised) =>
        raised?.kind === "auditSinkFailed" ? { kind: "auditSinkRecovered", sink: name } : null,
      );
    }
    return "delivered";
  } catch (caught) {
    if (caught instanceof LeaseLost) return "skipped";
    const error =
      domainErrorOf(caught) ??
      domainError("auditSinkUnreachable", {
        target: sink.name,
        reason: caught instanceof Error ? caught.message : String(caught),
      });
    const failures = sink.failures + 1;
    try {
      await advance(sink, {
        failures,
        retryAt: iso(now + backoffMs(failures)),
        lastError: error.message,
        lastErrorAt: nowIso(),
        lastErrorCode: JSON.stringify(stored(error)),
      });
    } catch (recordError) {
      if (!(recordError instanceof LeaseLost)) throw recordError;
      return "skipped";
    }
    if (failures >= FAILURES_BEFORE_ALERT) {
      await raiseProblem(problemKey, {
        kind: "auditSinkFailed",
        sink: sink.name,
        error: error.message,
        errorCode: stored(error),
      });
    }
    return "failed";
  } finally {
    await release(sink).catch((error: unknown) => {
      console.error(`[audit-stream] could not release sink ${sink.id}:`, error);
    });
  }
}

/** Every enabled sink at once, then the security queue's pruning. */
export async function streamTick(now = Date.now()): Promise<void> {
  const sinks = await db
    .select({ id: auditSinks.id })
    .from(auditSinks)
    .where(eq(auditSinks.enabled, true));
  await Promise.all(
    sinks.map((sink) =>
      deliverSink(sink.id, now).catch((error: unknown) => {
        console.error(`[audit-stream] pass for sink ${sink.id} failed:`, error);
      }),
    ),
  );
  await pruneSecurityRecords(now);
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Idempotent. A pass still running when the next wake comes is not overlapped. */
export function startAuditStreaming(): void {
  if (timer) return;
  const wake = () => {
    if (running) return;
    running = true;
    void streamTick()
      .catch((error: unknown) => {
        console.error("[audit-stream] pass failed:", error);
      })
      .finally(() => {
        running = false;
      });
  };
  wake();
  timer = setInterval(wake, TICK_MS);
  timer.unref();
}

/** On losing the lead; a pass already running finishes, and its lease keeps the next one off. */
export function stopAuditStreaming(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Whether the receiver refused the configured encoding, so the test went uncompressed. */
export type SinkTestResult = { encodingRefused: boolean };

/** One `test` record, straight to the sink: a saved one, or the form as typed. */
export async function testSink(
  id: number | null,
  input: SinkInput | null,
): Promise<SinkTestResult> {
  let sink: Sink | null;
  if (input) sink = await previewSink(input, id);
  else sink = id === null ? null : await getSink(id);
  if (!sink) throw domainError("auditSinkNotFound", {}, { status: 404 });
  let encodingRefused = false;
  await sendRecords(sink, [testRecord(nowIso())], {
    async onEncodingRefused() {
      encodingRefused = true;
    },
  });
  return { encodingRefused };
}

export {
  createSink,
  deleteSink,
  listSinks,
  type SinkInput,
  type SinkView,
  updateSink,
} from "./sinks";
