import LogsClient from "@cpm/controller/src/app/(dashboard)/logs/LogsClient";
import { DemoSurface } from "../DemoSurface";
import { json, serveApi } from "../fake-api";

const AGENTS = [
  { agentId: "edge-fra", name: "edge-fra", canReadLogs: true },
  { agentId: "edge-ams", name: "edge-ams", canReadLogs: true },
];

const HOSTS = ["app.example.com", "grafana.example.com", "vpn.example.com"];
const PATHS = [
  "/",
  "/api/items?page=2",
  "/assets/app.css",
  "/login",
  "/api/health",
  "/favicon.ico",
];
const CLIENTS = ["203.0.113.24", "198.51.100.61", "2001:db8::4a", "192.0.2.180"];

const pick = <T,>(items: T[], n: number): T => items[n % items.length] as T;

/** Caddy's JSON access entry, which the viewer folds onto one line. */
function accessEntry(n: number, at: number): string {
  const status = n % 11 === 5 ? 404 : n % 17 === 3 ? 502 : 200;
  return JSON.stringify({
    level: "info",
    ts: at / 1000,
    logger: "http.log.access",
    msg: "handled request",
    request: {
      client_ip: pick(CLIENTS, n),
      method: n % 7 === 2 ? "POST" : "GET",
      host: pick(HOSTS, n),
      uri: pick(PATHS, n * 3),
    },
    duration: 0.004 + (n % 9) * 0.011,
    status,
  });
}

/** One line per matched rule, in the ModSecurity message format Coraza writes. */
function wafEntry(n: number, at: number): string {
  const rules = [
    ["942100", "SQL Injection Attack Detected via libinjection", "CRITICAL"],
    ["930120", "OS File Access Attempt", "CRITICAL"],
    ["913100", "Found User-Agent associated with security scanner", "CRITICAL"],
  ];
  const [id, message, severity] = pick(rules, n);
  return JSON.stringify({
    level: "error",
    ts: at / 1000,
    logger: "http.handlers.waf",
    msg: `[client "${pick(CLIENTS, n)}"] Coraza: Warning. ${message} [id "${id}"] [msg "${message}"] [severity "${severity}"] [hostname "${pick(HOSTS, n)}"] [unique_id "demo${n}"]`,
  });
}

/** Caddy's own output: config loads and the certificate lines the Certificates view keeps. */
function caddyEntry(n: number, at: number): string {
  const lines = [
    { logger: "admin.api", msg: "received request", uri: "/load" },
    { logger: "tls.cache.maintenance", msg: "started background certificate maintenance" },
    {
      logger: "tls.obtain",
      msg: "acquiring lock",
      identifier: pick(HOSTS, n),
    },
    { logger: "http.acme_client", msg: "trying to solve challenge", challenge_type: "http-01" },
    { logger: "tls.obtain", msg: "certificate obtained successfully", identifier: pick(HOSTS, n) },
    { logger: "http", msg: "servers shutting down with eternal grace period" },
  ];
  return JSON.stringify({ level: "info", ts: at / 1000, ...pick(lines, n) });
}

const WRITERS = { access: accessEntry, waf: wafEntry, caddy: caddyEntry };

/**
 * Per agent and source, as the agent keeps one cursor per file. A first page is a backlog; each
 * later poll finds a line or two more, so Follow and Pause have something to do.
 */
const written = new Map<string, number>();

if (typeof window !== "undefined") {
  serveApi(async (url) => {
    if (url.pathname !== "/api/logs") return null;
    const agent = url.searchParams.get("agent") ?? "";
    const source = (url.searchParams.get("source") ?? "access") as keyof typeof WRITERS;
    const write = WRITERS[source];
    if (!write) return json({ error: "Unknown log" }, 400);
    const key = `${agent}:${source}`;
    const from = url.searchParams.get("cursor") ? (written.get(key) ?? 0) : 0;
    const count = from === 0 ? 24 : source === "access" ? 1 + (from % 2) : from % 3 === 0 ? 1 : 0;
    const now = Date.now();
    const lines = Array.from({ length: count }, (_, i) =>
      write(from + i + (agent === "edge-ams" ? 5 : 0), now - (count - i) * 1500),
    );
    written.set(key, from + count);
    return json({ lines, cursor: String(from + count) });
  });
}

/** The real viewer, reading pages the agent would send from an in-browser stand-in. */
export default function LogViewerDemo() {
  return (
    <DemoSurface>
      <LogsClient
        agents={AGENTS}
        initialAgent={null}
        initialView="access"
        initialHost={null}
        accessLogEnabled
      />
    </DemoSurface>
  );
}
