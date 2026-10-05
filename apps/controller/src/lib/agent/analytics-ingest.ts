/**
 * Agents are less trusted, so rows are checked field by field and stamped with the signer. A bad
 * row is dropped and counted: a refused batch is resent every pass and would stall for good.
 */

import {
  AGENT_ANALYTICS_KINDS,
  type AgentAnalyticsKind,
  type AgentAnalyticsResult,
  type TrafficEventRow,
  type WafEventRow,
  isTrafficOutcome,
  redactWafEventRow,
} from "@cpm/shared";
import { insertTrafficEvents, insertWafEvents, isAnalyticsEnabled } from "../clickhouse/client";
import db from "../db";
import { proxyHosts } from "../db/schema";
import { listHostAssignments, servedByAgent } from "../models/host-agents";

/** A URI or user agent past this is noise, not a request. */
const MAX_FIELD_CHARS = 64 * 1024;

/** Coraza's audit data carries request excerpts, so it gets more room. */
const MAX_RAW_DATA_CHARS = 1024 * 1024;

const MAX_DATETIME_SECONDS = 4_294_967_295;

export class AnalyticsIngestError extends Error {
  constructor(
    readonly code: "ANALYTICS_DISABLED" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "AnalyticsIngestError";
  }
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = MAX_FIELD_CHARS): value is string {
  return typeof value === "string" && value.length <= max;
}

function isOptionalText(value: unknown, max = MAX_FIELD_CHARS): value is string | null {
  return value === null || isText(value, max);
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Caddy logs fractional seconds, so this is the one number that need not be whole. */
function isTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_DATETIME_SECONDS
  );
}

const MAX_UINT32 = 4_294_967_295;

/** Absent from an older agent, which is fine; present and malformed, which is not. */
function isOptionalWhole(value: unknown, max: number): value is number | null | undefined {
  return value === undefined || value === null || isWhole(value, 0, max);
}

export function parseTrafficRow(value: unknown): TrafficEventRow | null {
  if (!isFields(value)) return null;
  const row = value;
  if (
    !isTimestamp(row.ts) ||
    !isText(row.client_ip) ||
    !isOptionalText(row.country_code) ||
    !isText(row.host) ||
    !isText(row.method) ||
    !isText(row.uri) ||
    !isWhole(row.status, 0, 65_535) ||
    !isText(row.proto) ||
    !isWhole(row.bytes_sent, 0, Number.MAX_SAFE_INTEGER) ||
    !isText(row.user_agent) ||
    typeof row.is_blocked !== "boolean" ||
    !isOptionalWhole(row.duration_ms, MAX_UINT32) ||
    !isOptionalWhole(row.asn, MAX_UINT32) ||
    !(row.asn_org === undefined || isOptionalText(row.asn_org, 1024))
  ) {
    return null;
  }
  // Rebuilt field by field, so a key the agent added cannot reach the insert.
  return {
    ts: row.ts,
    client_ip: row.client_ip,
    country_code: row.country_code,
    host: row.host,
    method: row.method,
    uri: row.uri,
    status: row.status,
    proto: row.proto,
    bytes_sent: row.bytes_sent,
    user_agent: row.user_agent,
    is_blocked: row.is_blocked,
    duration_ms: row.duration_ms ?? null,
    // A newer agent's outcome this controller has no name for counts as served, not as refused.
    outcome: isTrafficOutcome(row.outcome) ? row.outcome : row.is_blocked ? "geo" : "served",
    asn: row.asn ?? null,
    asn_org: row.asn_org ?? null,
  };
}

export function parseWafRow(value: unknown): WafEventRow | null {
  if (!isFields(value)) return null;
  const row = value;
  if (
    !isTimestamp(row.ts) ||
    !isText(row.host) ||
    !isText(row.client_ip) ||
    !isOptionalText(row.country_code) ||
    !(row.rule_id === null || isWhole(row.rule_id, -2_147_483_648, 2_147_483_647)) ||
    !isOptionalText(row.rule_message) ||
    !isOptionalText(row.severity) ||
    !isOptionalText(row.raw_data, MAX_RAW_DATA_CHARS) ||
    typeof row.blocked !== "boolean" ||
    !isText(row.method) ||
    !isText(row.uri)
  ) {
    return null;
  }
  // Again here: an older agent sends the audit entry unredacted.
  return redactWafEventRow({
    ts: row.ts,
    host: row.host,
    client_ip: row.client_ip,
    country_code: row.country_code,
    rule_id: row.rule_id,
    rule_message: row.rule_message,
    severity: row.severity,
    raw_data: row.raw_data,
    blocked: row.blocked,
    method: row.method,
    uri: row.uri,
  });
}

/** `host:port` and `[v6]:port` to the bare, lower-cased name, so a port cannot split a group. */
export function bareHost(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? lower : lower.slice(0, end + 1);
  }
  return lower.split(":").length === 2 ? lower.replace(/:\d*$/, "") : lower;
}

function matchesDomain(domains: ReadonlySet<string>, host: string): boolean {
  if (domains.has(host)) return true;
  const dot = host.indexOf(".");
  return dot !== -1 && domains.has(`*${host.slice(dot)}`);
}

/**
 * Whether a row's host is one this agent may report on: a host it serves, or one no proxy host
 * claims (scanners, the catch-all). A host pinned only to other agents is not its to report.
 */
export async function agentHostFilter(agentRowId: number): Promise<(host: string) => boolean> {
  const [rows, assignments] = await Promise.all([
    db.select({ id: proxyHosts.id, domains: proxyHosts.domains }).from(proxyHosts),
    listHostAssignments("http"),
  ]);
  const mine = new Set<string>();
  const others = new Set<string>();
  for (const row of rows) {
    let domains: unknown;
    try {
      domains = JSON.parse(row.domains);
    } catch {
      continue;
    }
    if (!Array.isArray(domains)) continue;
    const bucket = servedByAgent(assignments, row.id, agentRowId) ? mine : others;
    for (const domain of domains) if (typeof domain === "string") bucket.add(domain.toLowerCase());
  }
  return (host) => {
    const bare = bareHost(host);
    return matchesDomain(mine, bare) || !matchesDomain(others, bare);
  };
}

function isKind(value: unknown): value is AgentAnalyticsKind {
  return (AGENT_ANALYTICS_KINDS as readonly unknown[]).includes(value);
}

/** Throws when nothing can be written, so the agent keeps its place and resends. */
export async function ingestAnalytics(
  agentId: string,
  kind: unknown,
  rows: readonly unknown[],
  /** `agents.id`, which host assignments name. */
  agentRowId: number,
): Promise<AgentAnalyticsResult> {
  if (!isKind(kind)) {
    throw new AnalyticsIngestError("BAD_REQUEST", "Unknown analytics kind.");
  }
  // Before the analytics check: the admin notification counts them without ClickHouse.
  if (kind === "upstream-errors") {
    const { parseUpstreamErrorRow, recordUpstreamErrors } = await import(
      "../notifications/upstream-errors"
    );
    const valid = rows.map(parseUpstreamErrorRow).filter((row) => row !== null);
    await recordUpstreamErrors(valid).catch((error: unknown) => {
      console.error("[notifications] could not count upstream errors:", error);
    });
    return { accepted: valid.length, rejected: rows.length - valid.length };
  }
  if (!(await isAnalyticsEnabled())) {
    throw new AnalyticsIngestError("ANALYTICS_DISABLED", "Analytics are switched off.");
  }

  const serves = await agentHostFilter(agentRowId);
  const ours = <T extends { host: string }>(row: T | null): row is T =>
    row !== null && serves(row.host);
  if (kind === "traffic") {
    const valid = rows
      .map(parseTrafficRow)
      .filter(ours)
      .map((row) => ({ ...row, host: bareHost(row.host) }));
    await insertTrafficEvents(valid, agentId);
    return { accepted: valid.length, rejected: rows.length - valid.length };
  }

  const valid = rows
    .map(parseWafRow)
    .filter(ours)
    .map((row) => ({ ...row, host: bareHost(row.host) }));
  await insertWafEvents(valid, agentId);
  return { accepted: valid.length, rejected: rows.length - valid.length };
}
