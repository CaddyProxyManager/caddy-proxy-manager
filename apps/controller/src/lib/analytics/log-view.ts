/** Caddy's JSON log lines, made readable for the log viewer. */

import { trafficHostName } from "../proxy-hosts/traffic-status";

export type LogSource = "access" | "waf" | "caddy";
/** What the viewer offers: the agent's sources, plus ACME, which is Caddy's output filtered. */
export type LogView = LogSource | "acme";
export const LOG_VIEWS: readonly LogView[] = ["access", "waf", "caddy", "acme"];

export function isLogView(value: unknown): value is LogView {
  return (LOG_VIEWS as readonly unknown[]).includes(value);
}

function parse(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function time(ts: unknown): string {
  if (typeof ts === "number") return new Date(ts * 1000).toISOString();
  if (typeof ts === "string") return ts;
  return "";
}

/**
 * An access-log entry on one line: when, who, what, and how it went. Null for a line that isn't a
 * JSON access entry (the console log format), which is then shown as Caddy wrote it.
 */
export function accessLine(line: string): string | null {
  const entry = parse(line);
  const request = entry?.request as Record<string, unknown> | undefined;
  if (!entry || !request) return null;
  const client = request.client_ip ?? request.remote_ip ?? "";
  const duration =
    typeof entry.duration === "number" ? ` ${Math.round(entry.duration * 1000)}ms` : "";
  return [
    time(entry.ts),
    client,
    request.method,
    `${request.host ?? ""}${request.uri ?? ""}`,
    `-> ${entry.status ?? "?"}${duration}`,
  ]
    .filter((part) => part !== "" && part !== undefined)
    .join(" ");
}

/** Certificate issuance and renewal, from Caddy's own log. */
export function isAcmeLine(line: string): boolean {
  const entry = parse(line);
  const logger = typeof entry?.logger === "string" ? entry.logger : "";
  return logger.startsWith("tls") || logger.includes("acme");
}

/** What a host's own Logs tab offers: Caddy's other output names no site. */
export const HOST_LOG_VIEWS: readonly LogView[] = ["access", "waf", "acme"];

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** The sites a line was for, ports dropped; none for a line that names no site. */
export function lineHosts(view: LogView, line: string): string[] {
  const entry = parse(line);
  if (!entry) return [];
  let found: string[] = [];
  if (view === "access") {
    found = strings((entry.request as Record<string, unknown> | undefined)?.host);
  } else if (view === "waf") {
    const request = (entry.transaction as Record<string, unknown> | undefined)?.request as
      | Record<string, unknown>
      | undefined;
    const headers = request?.headers as Record<string, unknown> | undefined;
    found = strings(headers?.host ?? headers?.Host);
  } else if (view === "acme") {
    found = [...strings(entry.identifier), ...strings(entry.identifiers)];
  }
  return found.map(trafficHostName).filter((host) => host.length > 0);
}

/** A line nothing ties to a site is left out, so the lock never lets another site's through. */
export function isLineForHosts(view: LogView, line: string, hosts: ReadonlySet<string>): boolean {
  return lineHosts(view, line).some((host) => hosts.has(host));
}
