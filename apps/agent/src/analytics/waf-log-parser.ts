/**
 * Coraza's audit log, turned into WAF events. On the agent because the file is on this host; the
 * offset lives in the agent's SQLite and the rows are relayed to the controller.
 */
import { existsSync, statSync, truncateSync } from "node:fs";
import maxmind, { type CountryResponse } from "maxmind";
import type { WafEventRow } from "@cpm/shared";
import type { AgentStore } from "../db";
import { relayWafEvents } from "./relay";
import { readLines } from "./log-read";
import { geoipCountryDb, wafAuditLogPath, wafRulesLogPath } from "./paths";

const AUDIT_LOG = wafAuditLogPath();
const RULES_LOG = wafRulesLogPath();
const BATCH_SIZE = 200;
// SecAuditLog has no rotation of its own (unlike the Caddy-written logs), so once fully ingested
// it is truncated in place past this size.
const AUDIT_LOG_TRUNCATE_THRESHOLD = 100 * 1024 * 1024;

let geoReader: Awaited<ReturnType<typeof maxmind.open<CountryResponse>>> | null = null;
const geoCache = new Map<string, string | null>();

let stopped = false;

// ── state helpers ─────────────────────────────────────────────────────────────

let store: AgentStore | null = null;

export function bindStore(next: AgentStore): void {
  store = next;
}

async function getState(key: string): Promise<string | null> {
  return store?.parseState(key) ?? null;
}

async function setState(key: string, value: string): Promise<void> {
  store?.setParseState(key, value);
}

// ── GeoIP ─────────────────────────────────────────────────────────────────────

async function initGeoIP(): Promise<void> {
  const database = geoipCountryDb();
  if (!existsSync(database)) return;
  try {
    geoReader = await maxmind.open<CountryResponse>(database);
  } catch {
    // GeoIP optional
  }
}

function lookupCountry(ip: string): string | null {
  if (!geoReader) return null;
  if (geoCache.has(ip)) return geoCache.get(ip)!;
  if (geoCache.size > 10_000) geoCache.clear();
  try {
    const result = geoReader.get(ip);
    const code = result?.country?.iso_code ?? null;
    geoCache.set(ip, code);
    return code;
  } catch {
    geoCache.set(ip, null);
    return null;
  }
}

// ── WAF rules log parsing ─────────────────────────────────────────────────────
// One JSON line per matched rule holding a ModSecurity message, mapped by unique_id.

interface RuleInfo {
  ruleId: number | null;
  ruleMessage: string | null;
  severity: string | null;
}

// Cached per field name: this runs several times per audit message and rules-log line.
const bracketFieldPatterns = new Map<string, RegExp>();

export function extractBracketField(msg: string, field: string): string | null {
  let pattern = bracketFieldPatterns.get(field);
  if (!pattern) {
    pattern = new RegExp(`\\[${field} "([^"]*)"\\]`);
    bracketFieldPatterns.set(field, pattern);
  }
  const m = msg.match(pattern);
  return m ? m[1] : null;
}

// They report the accumulated score, not a specific attack, so they are never an event's rule.
function isAnomalyEvaluationRule(ruleId: number | null): boolean {
  return ruleId === 949110 || ruleId === 980130;
}

/** RuleInfo from a ModSecurity rule string, or null if it is not a specific attack rule. */
export function ruleInfoFromMessage(msg: string): RuleInfo | null {
  const ruleIdStr = extractBracketField(msg, "id");
  const ruleId = ruleIdStr ? parseInt(ruleIdStr, 10) : null;
  if (isAnomalyEvaluationRule(ruleId)) return null;
  return {
    ruleId,
    ruleMessage: extractBracketField(msg, "msg"),
    severity: extractBracketField(msg, "severity"),
  };
}

async function readRulesLog(
  startOffset: number,
): Promise<{ ruleMap: Map<string, RuleInfo>; newOffset: number }> {
  const ruleMap = new Map<string, RuleInfo>();
  const { lines, newOffset } = await readLines(startOffset, RULES_LOG);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { msg?: string };
      const msg = entry.msg ?? "";
      const uniqueId = extractBracketField(msg, "unique_id");
      if (!uniqueId) continue;
      if (ruleMap.has(uniqueId)) continue;
      const info = ruleInfoFromMessage(msg);
      if (!info) continue;
      ruleMap.set(uniqueId, info);
    } catch {
      // skip malformed lines
    }
  }

  return { ruleMap, newOffset };
}

// ── audit log parsing ─────────────────────────────────────────────────────────

interface CorazaAuditEntry {
  transaction?: {
    id?: string;
    client_ip?: string;
    unix_timestamp?: number;
    timestamp?: string;
    // true when the WAF blocked or detected the request
    is_interrupted?: boolean;
    request?: {
      method?: string;
      uri?: string;
      // lowercase keys
      headers?: Record<string, string[]>;
    };
  };
  // Only with audit part H (or K): one ModSecurity rule string per matched rule.
  messages?: { message?: string; error_message?: string }[];
}

/**
 * First specific matched rule from the entry's own `messages` (audit part H). Deterministic,
 * where a join against waf-rules.log loses events on tick edges.
 */
export function ruleInfoFromAuditEntry(entry: CorazaAuditEntry): RuleInfo | null {
  for (const m of entry.messages ?? []) {
    const msg = m.error_message || m.message || "";
    if (!msg) continue;
    const info = ruleInfoFromMessage(msg);
    // A real attack rule usually precedes the anomaly-evaluation ones, but not always.
    if (info && info.ruleId !== null) return info;
  }
  return null;
}

export function parseLine(line: string, ruleMap: Map<string, RuleInfo>): WafEventRow | null {
  let entry: CorazaAuditEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const tx = entry.transaction;
  if (!tx) return null;

  const clientIp = tx.client_ip ?? "";
  if (!clientIp) return null;

  const req = tx.request ?? {};

  let ts: number;
  if (tx.unix_timestamp) {
    ts = Math.floor(tx.unix_timestamp / 1e9);
  } else if (tx.timestamp) {
    ts = Math.floor(new Date(tx.timestamp).getTime() / 1000);
  } else {
    ts = Math.floor(Date.now() / 1000);
  }

  const hostArr = req.headers?.host ?? req.headers?.Host;
  const host = Array.isArray(hostArr) ? (hostArr[0] ?? "") : (hostArr ?? "");

  // The waf-rules.log join is only for Coraza builds that don't populate `messages`.
  const ruleInfo = ruleInfoFromAuditEntry(entry) ?? (tx.id ? ruleMap.get(tx.id) : undefined);

  const blocked = tx.is_interrupted ?? false;

  // No rule match and not blocked is a clean request.
  if (!blocked && !ruleInfo) return null;

  return {
    ts,
    host,
    client_ip: clientIp,
    country_code: lookupCountry(clientIp),
    method: req.method ?? "",
    uri: req.uri ?? "",
    rule_id: ruleInfo?.ruleId ?? null,
    rule_message: ruleInfo?.ruleMessage ?? null,
    severity: ruleInfo?.severity ?? null,
    raw_data: line,
    blocked,
  };
}

async function readAuditLog(startOffset: number): Promise<{ lines: string[]; newOffset: number }> {
  return readLines(startOffset, AUDIT_LOG);
}

/**
 * For a file gone or replaced: an offset from another inode parks the parser past EOF, since the
 * rotation guard only fires when the file shrinks.
 */
async function resetAuditLogState(): Promise<void> {
  await setState("waf_audit_log_offset", "0");
  await setState("waf_audit_log_size", "0");
  await setState("waf_audit_log_inode", "0");
}

// Once per episode, so a missing or untruncatable audit log is surfaced without a line every 30s.
let warnedAuditLogMissing = false;
let warnedTruncateFailed = false;

async function insertBatch(rows: WafEventRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await relayWafEvents(rows.slice(i, i + BATCH_SIZE));
  }
}

// ── public API ────────────────────────────────────────────────────────────────

export async function initWafLogParser(): Promise<void> {
  stopped = false;
  await initGeoIP();
  console.log("[waf-log-parser] initialized");
}

export async function parseNewWafLogEntries(): Promise<void> {
  if (stopped) return;

  // Coraza keeps writing to the unlinked inode and never recreates the file, so surface it and
  // clear the stale offset so a recreated file is read from the start.
  if (!existsSync(AUDIT_LOG)) {
    if (!warnedAuditLogMissing) {
      console.warn(
        `[waf-log-parser] ${AUDIT_LOG} is missing - WAF events cannot be ingested until Caddy recreates it (restart the caddy container).`,
      );
      warnedAuditLogMissing = true;
      await resetAuditLogState();
    }
    return;
  }
  warnedAuditLogMissing = false;

  try {
    // ── 1. Parse WAF rules log to build unique_id → rule info map ────────────
    const rulesOffset = parseInt((await getState("waf_rules_log_offset")) ?? "0", 10);
    const rulesSize = parseInt((await getState("waf_rules_log_size")) ?? "0", 10);

    let currentRulesSize = 0;
    if (existsSync(RULES_LOG)) {
      try {
        currentRulesSize = statSync(RULES_LOG).size;
      } catch {
        /* ignore */
      }
    }
    const rulesStartOffset = currentRulesSize < rulesSize ? 0 : rulesOffset;
    const { ruleMap, newOffset: newRulesOffset } = await readRulesLog(rulesStartOffset);

    await setState("waf_rules_log_offset", String(newRulesOffset));
    await setState("waf_rules_log_size", String(currentRulesSize));

    // ── 2. Parse audit log, enriching events with rule info from map ─────────
    const storedOffset = parseInt((await getState("waf_audit_log_offset")) ?? "0", 10);
    const storedSize = parseInt((await getState("waf_audit_log_size")) ?? "0", 10);
    const storedInode = parseInt((await getState("waf_audit_log_inode")) ?? "0", 10);

    let currentSize: number;
    let currentInode: number;
    try {
      const st = statSync(AUDIT_LOG);
      currentSize = st.size;
      currentInode = Number(st.ino);
    } catch {
      return;
    }

    // Size alone misses a delete-and-recreate that already grew past the stored offset.
    const replaced = storedInode !== 0 && currentInode !== storedInode;
    const startOffset = currentSize < storedSize || replaced ? 0 : storedOffset;
    if (replaced) {
      console.warn(
        "[waf-log-parser] waf-audit.log was replaced (new inode) - re-reading from the start",
      );
    }

    const { lines, newOffset } = await readAuditLog(startOffset);

    if (lines.length > 0) {
      const rows = lines
        .map((l) => parseLine(l, ruleMap))
        .filter((r): r is WafEventRow => r !== null);
      if (rows.length > 0) {
        await insertBatch(rows);
        console.log(`[waf-log-parser] inserted ${rows.length} WAF events`);
      }
    }

    // Before truncating: truncation fails with EACCES when the file is not group-writable, and a
    // frozen offset re-inserts the same tail on every pass.
    await setState("waf_audit_log_offset", String(newOffset));
    await setState("waf_audit_log_size", String(currentSize));
    await setState("waf_audit_log_inode", String(currentInode));

    // Safe once read to EOF: Coraza writes with O_APPEND, so later writes land at the new end.
    if (newOffset === currentSize && currentSize > AUDIT_LOG_TRUNCATE_THRESHOLD) {
      try {
        truncateSync(AUDIT_LOG, 0);
        await setState("waf_audit_log_offset", "0");
        await setState("waf_audit_log_size", "0");
        warnedTruncateFailed = false;
        console.log(
          `[waf-log-parser] truncated waf-audit.log after ingesting ${currentSize} bytes`,
        );
      } catch (err) {
        if (!warnedTruncateFailed) {
          const code = (err as NodeJS.ErrnoException).code;
          console.warn(
            `[waf-log-parser] could not truncate ${AUDIT_LOG} (${code ?? err}); ` +
              "it will keep growing. Ingestion is unaffected. The Agents page shows the command " +
              "that fixes it.",
          );
          warnedTruncateFailed = true;
        }
      }
    }
  } catch (err) {
    console.error("[waf-log-parser] error during parse:", err);
  }
}

export function stopWafLogParser(): void {
  stopped = true;
}
