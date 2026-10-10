/**
 * Security records: WAF events and other mitigated requests, queued as they are ingested while a
 * sink includes them, and dropped once every such sink has them. They are not audit events and
 * not chained; `seq` is this queue's own, handed out under the head row's lock so it is commit
 * order. The queue never waits for a slow sink: past a day or 100,000 records the oldest go, and
 * the sink records the gap.
 */

import { redactQueryString, type TrafficEventRow, type WafEventRow } from "@cpm/shared";
import { and, asc, desc, eq, gt, lt, lte } from "drizzle-orm";
import db, { nowIso, runInTransaction } from "../db";
import { type Step, readingStep } from "../db/reading-step";
import { auditSecurityHead, auditSecurityRecords, auditSinks, schemaDialect } from "../db/schema";
import { onAnnouncement } from "../cluster/announcements";
import { dropProcessMemo, processMemo } from "../settings/process-memo";
import { type SecurityRecord, type SecurityRecordBody, securityRecord } from "./records";

const HEAD_ID = 1;
export const SECURITY_KEEP_MS = 24 * 60 * 60_000;
export const SECURITY_KEEP_RECORDS = 100_000;
/** Rows per insert: well inside SQLite's bound-parameter limit. */
const INSERT_CHUNK = 500;

type Head = typeof auditSecurityHead.$inferSelect;
// biome-ignore lint/suspicious/noExplicitAny: builder types are per-dialect
type Builder = any;

function* lockHead(tx: Builder): Generator<Step, Head, unknown[]> {
  const select = () => {
    const query = tx.select().from(auditSecurityHead).where(eq(auditSecurityHead.id, HEAD_ID));
    return schemaDialect === "postgres" ? query.for("update") : query;
  };
  let [head] = (yield { all: select() }) as Head[];
  if (!head) {
    yield {
      run: tx
        .insert(auditSecurityHead)
        .values({ id: HEAD_ID, headSeq: 0, prunedSeq: 0, updatedAt: nowIso() })
        .onConflictDoNothing(),
    };
    [head] = (yield { all: select() }) as Head[];
  }
  return head as Head;
}

const iso = (seconds: number) => new Date(Math.floor(seconds * 1000)).toISOString();

export function wafSecurityBody(row: WafEventRow): SecurityRecordBody {
  return {
    type: "waf",
    createdAt: iso(row.ts),
    host: row.host,
    clientIp: row.client_ip,
    countryCode: row.country_code,
    method: row.method,
    uri: row.uri,
    ruleId: row.rule_id,
    ruleMessage: row.rule_message,
    severity: row.severity,
    blocked: row.blocked,
  };
}

/** Null for a request that was served: only mitigated ones are security records. */
export function trafficSecurityBody(row: TrafficEventRow): SecurityRecordBody | null {
  if (!row.outcome || row.outcome === "served") return null;
  return {
    type: "mitigated",
    createdAt: iso(row.ts),
    host: row.host,
    clientIp: row.client_ip,
    countryCode: row.country_code,
    method: row.method,
    // Stored unredacted for analytics; a credential in the query string stays home.
    uri: redactQueryString(row.uri),
    status: row.status,
    outcome: row.outcome,
  };
}

export const SECURITY_WANTED_MEMO = "audit-sinks:security-wanted";

/** Held per process: every analytics batch asks. Sink writes announce `audit-sinks` to drop it. */
export function securityWanted(): Promise<boolean> {
  return processMemo(SECURITY_WANTED_MEMO, async () => {
    const [row] = await db
      .select({ id: auditSinks.id })
      .from(auditSinks)
      .where(and(eq(auditSinks.enabled, true), eq(auditSinks.includeSecurity, true)))
      .limit(1);
    return row !== undefined;
  });
}

onAnnouncement("audit-sinks", () => dropProcessMemo(SECURITY_WANTED_MEMO));

/** At ingest. Nothing is kept unless some enabled sink includes security records. */
export async function queueSecurityRecords(bodies: SecurityRecordBody[]): Promise<void> {
  if (bodies.length === 0 || !(await securityWanted())) return;
  const at = nowIso();
  await runInTransaction((tx) => [
    readingStep(function* () {
      const head = yield* lockHead(tx);
      let seq = head.headSeq;
      const rows = bodies.map((body) => {
        seq += 1;
        return { seq, record: JSON.stringify(body), createdAt: at };
      });
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        yield { run: tx.insert(auditSecurityRecords).values(rows.slice(i, i + INSERT_CHUNK)) };
      }
      yield {
        run: tx
          .update(auditSecurityHead)
          .set({ headSeq: seq, updatedAt: at })
          .where(eq(auditSecurityHead.id, HEAD_ID)),
      };
    }),
  ]);
}

export async function securityHead(): Promise<{ headSeq: number; prunedSeq: number }> {
  const [head] = await db.select().from(auditSecurityHead).where(eq(auditSecurityHead.id, HEAD_ID));
  return { headSeq: head?.headSeq ?? 0, prunedSeq: head?.prunedSeq ?? 0 };
}

export async function readSecurityRecords(after: number, limit: number): Promise<SecurityRecord[]> {
  const rows = await db
    .select()
    .from(auditSecurityRecords)
    .where(gt(auditSecurityRecords.seq, after))
    .orderBy(asc(auditSecurityRecords.seq))
    .limit(limit);
  return rows.map((row) => securityRecord(row.seq, JSON.parse(row.record) as SecurityRecordBody));
}

/**
 * Drops what every sink taking security records has, and past the age and count limits what any
 * has not. `prunedSeq` only rises, so a sink behind it knows exactly what it missed.
 */
export async function pruneSecurityRecords(now = Date.now()): Promise<void> {
  // Nothing was ever queued: the head row is made by the first queueing, not by every leader.
  const [exists] = await db
    .select({ id: auditSecurityHead.id })
    .from(auditSecurityHead)
    .where(eq(auditSecurityHead.id, HEAD_ID));
  if (!exists) return;
  const sinks = await db
    .select({ cursor: auditSinks.securityCursor })
    .from(auditSinks)
    .where(and(eq(auditSinks.enabled, true), eq(auditSinks.includeSecurity, true)));
  const { headSeq } = await securityHead();
  let through = sinks.length === 0 ? headSeq : Math.min(...sinks.map((sink) => sink.cursor));
  const [aged] = await db
    .select({ seq: auditSecurityRecords.seq })
    .from(auditSecurityRecords)
    .where(lt(auditSecurityRecords.createdAt, new Date(now - SECURITY_KEEP_MS).toISOString()))
    .orderBy(desc(auditSecurityRecords.seq))
    .limit(1);
  through = Math.max(through, aged?.seq ?? 0, headSeq - SECURITY_KEEP_RECORDS);
  through = Math.min(through, headSeq);
  await runInTransaction((tx) => [
    readingStep(function* () {
      const head = yield* lockHead(tx);
      if (through <= head.prunedSeq) {
        yield {
          run: tx.delete(auditSecurityRecords).where(lte(auditSecurityRecords.seq, head.prunedSeq)),
        };
        return;
      }
      yield { run: tx.delete(auditSecurityRecords).where(lte(auditSecurityRecords.seq, through)) };
      yield {
        run: tx
          .update(auditSecurityHead)
          .set({ prunedSeq: through, updatedAt: nowIso() })
          .where(eq(auditSecurityHead.id, HEAD_ID)),
      };
    }),
  ]);
}
