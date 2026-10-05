/**
 * A stable name for a stored WAF event, which ClickHouse rows lack: its second plus a digest of
 * what it holds. Computed from the row as stored, before any read-time redaction.
 */
import { createHash } from "node:crypto";

export type KeyedWafRow = {
  ts: number;
  clientIp: string;
  method: string;
  uri: string;
  ruleId: number | null;
  rawData: string | null;
};

function transactionId(rawData: string | null): string {
  if (!rawData) return "";
  return /"id"\s*:\s*"([^"]{1,128})"/.exec(rawData)?.[1] ?? "";
}

export function wafEventKey(row: KeyedWafRow): string {
  const digest = createHash("sha256")
    .update(
      [row.clientIp, row.method, row.uri, row.ruleId ?? "", transactionId(row.rawData)].join("\n"),
    )
    .digest("hex")
    .slice(0, 20);
  return `${row.ts}.${digest}`;
}

/** The second a key names, or null for one that is not a key. */
export function wafEventKeyTs(key: string): number | null {
  const match = /^(\d{1,12})\.[0-9a-f]{20}$/.exec(key);
  return match ? Number(match[1]) : null;
}
