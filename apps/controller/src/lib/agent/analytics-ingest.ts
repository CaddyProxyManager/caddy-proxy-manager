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
} from "@cpm/shared";
import { insertTrafficEvents, insertWafEvents, isAnalyticsEnabled } from "../clickhouse/client";

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
    typeof row.is_blocked !== "boolean"
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
  return {
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
): Promise<AgentAnalyticsResult> {
  if (!isKind(kind)) {
    throw new AnalyticsIngestError("BAD_REQUEST", "Unknown analytics kind.");
  }
  if (!(await isAnalyticsEnabled())) {
    throw new AnalyticsIngestError("ANALYTICS_DISABLED", "Analytics are switched off.");
  }

  if (kind === "traffic") {
    const valid = rows.map(parseTrafficRow).filter((row) => row !== null);
    await insertTrafficEvents(valid, agentId);
    return { accepted: valid.length, rejected: rows.length - valid.length };
  }

  const valid = rows.map(parseWafRow).filter((row) => row !== null);
  await insertWafEvents(valid, agentId);
  return { accepted: valid.length, rejected: rows.length - valid.length };
}
