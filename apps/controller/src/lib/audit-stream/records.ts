/**
 * What a sink receives, one JSON object per record. An audit record carries the chain's own
 * fields under their stored names, so a receiver can check each `prevHash` against the hash
 * before it, and anyone holding the chain key can recompute `hash` (lib/audit/chain.ts).
 */

import type { auditEvents } from "../db/schema";

export const RECORD_VERSION = 1;

export type AuditRecord = {
  v: typeof RECORD_VERSION;
  kind: "audit";
  seq: number;
  prevHash: string;
  hash: string;
  actorId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  /** As stored: the JSON text the hash covers, not a parsed object. */
  data: string | null;
  createdAt: string;
};

/** What ingest queues; `seq` is added when it is handed out. */
export type SecurityRecordBody =
  | {
      type: "waf";
      createdAt: string;
      host: string;
      clientIp: string;
      countryCode: string | null;
      method: string;
      uri: string;
      ruleId: number | null;
      ruleMessage: string | null;
      severity: string | null;
      blocked: boolean;
    }
  | {
      type: "mitigated";
      createdAt: string;
      host: string;
      clientIp: string;
      countryCode: string | null;
      method: string;
      uri: string;
      status: number;
      outcome: string;
    };

/** Outside the hash chain, and says so: its `seq` is the security stream's own. */
export type SecurityRecord = {
  v: typeof RECORD_VERSION;
  kind: "security";
  seq: number;
  chained: false;
} & SecurityRecordBody;

/** Records pruned before this sink took them: `from` to `to` of `stream` will never arrive. */
export type GapRecord = {
  v: typeof RECORD_VERSION;
  kind: "gap";
  stream: "audit" | "security";
  from: number;
  to: number;
  createdAt: string;
};

export type TestRecord = { v: typeof RECORD_VERSION; kind: "test"; createdAt: string };

export type StreamRecord = AuditRecord | SecurityRecord | GapRecord | TestRecord;

type EventRow = typeof auditEvents.$inferSelect;

export function auditRecord(row: EventRow): AuditRecord {
  return {
    v: RECORD_VERSION,
    kind: "audit",
    seq: row.seq as number,
    prevHash: row.prevHash ?? "",
    hash: row.hash ?? "",
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: row.summary,
    data: row.data,
    createdAt: row.createdAt,
  };
}

export function securityRecord(seq: number, body: SecurityRecordBody): SecurityRecord {
  return { v: RECORD_VERSION, kind: "security", seq, chained: false, ...body };
}

export function gapRecord(
  stream: GapRecord["stream"],
  from: number,
  to: number,
  createdAt: string,
): GapRecord {
  return { v: RECORD_VERSION, kind: "gap", stream, from, to, createdAt };
}

export function testRecord(createdAt: string): TestRecord {
  return { v: RECORD_VERSION, kind: "test", createdAt };
}
