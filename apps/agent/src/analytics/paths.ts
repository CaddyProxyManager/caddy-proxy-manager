/**
 * Only `node:path`, so the parsers need not import the GeoIP fetcher and a `node:fs` mock need
 * not cover its exports.
 */

import { dirname, join } from "node:path";

export function accessLogPath(): string {
  return process.env.CADDY_ACCESS_LOG || "/logs/access.log";
}

export function wafAuditLogPath(): string {
  return process.env.WAF_AUDIT_LOG || "/logs/waf-audit.log";
}

export function wafRulesLogPath(): string {
  return process.env.WAF_RULES_LOG || "/logs/waf-rules.log";
}

export function logsDir(): string {
  return dirname(accessLogPath());
}

/** The agent is not root, so its own volume is where it can write; Caddy mounts it read-only. */
export function geoipDir(): string {
  return process.env.GEOIP_DIR || join(process.env.DATA_DIR || "/data", "geoip");
}

export function geoipCountryDb(): string {
  return process.env.GEOIP_DB || join(geoipDir(), "GeoLite2-Country.mmdb");
}
