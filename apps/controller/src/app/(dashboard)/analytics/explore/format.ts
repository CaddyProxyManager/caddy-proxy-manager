import type { TrafficOutcome } from "@cpm/shared";
import type { useFormatter } from "next-intl";
import type { FilterField, TopDimension } from "@/src/lib/analytics/explore-state";
import type { Hue } from "@/components/ui/accent";

type Formatter = ReturnType<typeof useFormatter>;

/** Through next-intl, not `toFixed`, which writes English's decimal separator in every locale. */
export function formatBytes(format: Formatter, bytes: number): string {
  const fixed = (value: number, digits: number) =>
    format.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (bytes < 1024) return `${format.number(bytes)} B`;
  if (bytes < 1024 * 1024) return `${fixed(bytes / 1024, 1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${fixed(bytes / 1024 / 1024, 1)} MB`;
  return `${fixed(bytes / 1024 / 1024 / 1024, 2)} GB`;
}

export function formatShare(format: Formatter, part: number, whole: number): string {
  return format.number(whole > 0 ? part / whole : 0, {
    style: "percent",
    maximumFractionDigits: 1,
  });
}

/** Catalog keys are camelCase; outcomes are the log's snake_case. */
export const OUTCOME_KEY = {
  served: "served",
  waf: "waf",
  geo: "geo",
  access: "access",
  auth: "auth",
  rate_limit: "rateLimit",
  crowdsec: "crowdsec",
  blocked: "blocked",
} as const satisfies Record<TrafficOutcome, string>;

/** Fixed per outcome, so a colour means the same gate in the chart, the log and the docs. */
export const OUTCOME_HUE: Record<TrafficOutcome, Hue> = {
  served: "green",
  waf: "red",
  geo: "orange",
  access: "yellow",
  auth: "purple",
  rate_limit: "cyan",
  crowdsec: "pink",
  blocked: "gray",
};

export const FIELD_KEY = {
  host: "host",
  path: "path",
  country: "country",
  asn: "asn",
  status: "status",
  method: "method",
  proto: "proto",
  ip: "ip",
  ua: "ua",
  outcome: "outcome",
  rule: "rule",
} as const satisfies Record<FilterField, string>;

export const TOP_TITLE_KEY = {
  host: "hosts",
  path: "paths",
  country: "countries",
  asn: "asns",
  status: "statusCodes",
  ip: "clientIps",
  ua: "userAgents",
  method: "methods",
  proto: "httpVersions",
  rule: "wafRules",
} as const satisfies Record<TopDimension, string>;

export function countryFlag(code: string): string {
  if (code?.length !== 2 || code === "XX") return "🌐";
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

export function formatBucket(format: Formatter, ts: number, rangeSeconds: number): string {
  const d = new Date(ts * 1000);
  if (rangeSeconds <= 86400) return format.dateTime(d, { hour: "2-digit", minute: "2-digit" });
  if (rangeSeconds <= 7 * 86400) {
    return format.dateTime(d, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return format.dateTime(d, { month: "short", day: "numeric" });
}
