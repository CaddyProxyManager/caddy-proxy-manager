/**
 * Invented demo traffic: a seeded month, then live minutes, so every range has data. Shaped, not
 * uniform, because a flat chart teaches nobody what the dashboard is for.
 */
import type { TrafficEventRow, WafEventRow } from "../clickhouse/client";

export type TrafficShare = { domain: string; share: number };

/** A host added in the demo gets the default. */
export const DEMO_HOST_SHARES: Record<string, number> = {
  "jellyfin.example.com": 30,
  "photos.example.com": 18,
  "cloud.example.com": 15,
  "grafana.example.com": 10,
  "home.example.com": 9,
  "git.example.com": 7,
  "vault.example.com": 5,
  "status.example.com": 4,
  "paperless.example.com": 2,
};
const DEFAULT_SHARE = 4;

/** Requests an hour at the peak; everything scales off it. */
export const PEAK_PER_HOUR = 900;

const COUNTRIES = [
  ["GB", 26],
  ["US", 22],
  ["DE", 13],
  ["NL", 8],
  ["FR", 7],
  ["SE", 5],
  ["PL", 4],
  ["ES", 4],
  ["CA", 3],
  ["BR", 3],
  ["IN", 3],
  ["AU", 2],
  ["JP", 2],
  ["IE", 2],
  ["IT", 2],
  ["NO", 1],
  ["ZA", 1],
] as const;

const AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Version/18.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
  "Jellyfin-Android/2.6.2",
  "curl/8.11.1",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

const PATHS = [
  "/",
  "/login",
  "/api/status",
  "/api/v1/items",
  "/assets/app.js",
  "/assets/app.css",
  "/media/library",
  "/media/stream",
  "/favicon.ico",
  "/health",
];

const PROBE_PATHS = [
  "/wp-login.php",
  "/.env",
  "/admin/config.php",
  "/../../etc/passwd",
  "/search?q=' OR 1=1--",
  "/?id=<script>alert(1)</script>",
];

const WAF_RULES = [
  [942100, "SQL Injection Attack Detected via libinjection", "CRITICAL"],
  [941100, "XSS Attack Detected via libinjection", "CRITICAL"],
  [930110, "Path Traversal Attack (/../)", "ERROR"],
  [930130, "Restricted File Access Attempt", "ERROR"],
  [913100, "Found User-Agent associated with security scanner", "WARNING"],
  [920350, "Host header is a numeric IP address", "WARNING"],
] as const;

const ATTACKER_COUNTRIES = ["CN", "RU", "US", "NL", "VN", "BR"] as const;

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

function weighted<T>(entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = Math.random() * total;
  for (const [value, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return value;
  }
  return entries[0]![0];
}

function busyness(date: Date): number {
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const daily = 0.15 + 0.85 * Math.max(0, Math.sin(((hour - 5) / 24) * Math.PI * 2) * 0.5 + 0.5);
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 0.65 : 1;
  return daily * weekend;
}

function randomIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `${Math.floor(Math.random() * 180) + 20}.${octet()}.${octet()}.${octet()}`;
}

/** A fixed pool: one address per request would make unique visitors equal requests. */
const VISITOR_IPS = Array.from({ length: 3000 }, randomIp);
const REGULARS = 20;
/** A scanner comes back rather than arriving once. */
const ATTACKER_IPS = Array.from({ length: 60 }, randomIp);

function visitorIp(): string {
  const pool = Math.random() < 0.2 ? REGULARS : VISITOR_IPS.length;
  return VISITOR_IPS[Math.floor(Math.random() * pool)] as string;
}

function status(): number {
  const r = Math.random();
  if (r > 0.985) return pick([500, 502, 503, 504]);
  if (r > 0.94) return pick([404, 404, 404, 401, 403]);
  if (r > 0.9) return pick([301, 302, 304]);
  return 200;
}

export function trafficShares(domains: string[]): TrafficShare[] {
  return domains.map((domain) => ({ domain, share: DEMO_HOST_SHARES[domain] ?? DEFAULT_SHARE }));
}

/** A fractional count rounds by chance: 0.4 requests is one request 40% of the time. */
export function generateTraffic(
  from: number,
  to: number,
  hosts: TrafficShare[],
): { traffic: TrafficEventRow[]; waf: WafEventRow[] } {
  const traffic: TrafficEventRow[] = [];
  const waf: WafEventRow[] = [];
  if (hosts.length === 0 || to <= from) return { traffic, waf };
  const hostEntries = hosts.map((host) => [host.domain, host.share] as const);

  for (let start = from; start < to; start += 3600) {
    const span = Math.min(3600, to - start);
    const expected = PEAK_PER_HOUR * busyness(new Date(start * 1000)) * (span / 3600);
    const count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);

    for (let i = 0; i < count; i++) {
      const ts = start + Math.floor(Math.random() * span);
      const host = weighted(hostEntries);
      const code = status();
      const media = Math.random() < 0.15;
      traffic.push({
        ts,
        client_ip: visitorIp(),
        country_code: weighted(COUNTRIES),
        host,
        method: Math.random() > 0.86 ? "POST" : "GET",
        uri: pick(PATHS),
        status: code,
        proto: Math.random() > 0.25 ? "HTTP/2.0" : Math.random() > 0.3 ? "HTTP/1.1" : "HTTP/3.0",
        bytes_sent: media
          ? Math.floor(Math.random() * 40_000_000) + 1_000_000
          : Math.floor(Math.random() * 180_000) + 400,
        user_agent: pick(AGENTS),
        is_blocked: false,
      });
    }

    // Scanners do not sleep.
    const expectedProbes = (span / 3600) * (6 + Math.random() * 10);
    const probes = Math.floor(expectedProbes) + (Math.random() < expectedProbes % 1 ? 1 : 0);
    for (let i = 0; i < probes; i++) {
      const ts = start + Math.floor(Math.random() * span);
      const host = weighted(hostEntries);
      const ip = pick(ATTACKER_IPS);
      const country = pick(ATTACKER_COUNTRIES);
      const uri = pick(PROBE_PATHS);
      const [ruleId, message, severity] = pick(WAF_RULES);
      const blocked = Math.random() < 0.85;
      waf.push({
        ts,
        host,
        client_ip: ip,
        country_code: country,
        rule_id: ruleId,
        rule_message: message,
        severity,
        raw_data: null,
        blocked,
        method: "GET",
        uri,
      });
      traffic.push({
        ts,
        client_ip: ip,
        country_code: country,
        host,
        method: "GET",
        uri,
        status: blocked ? 403 : 404,
        proto: "HTTP/1.1",
        bytes_sent: 0,
        user_agent: "Mozilla/5.0 zgrab/0.x",
        is_blocked: blocked,
      });
    }
  }

  return { traffic, waf };
}

/** An hour at a time, so a month never sits in memory. */
export async function writeDemoTraffic(
  from: number,
  to: number,
  hosts: TrafficShare[],
): Promise<{ traffic: number; waf: number }> {
  const { insertTrafficEvents, insertWafEvents } = await import("../clickhouse/client");
  const written = { traffic: 0, waf: 0 };
  for (let start = from; start < to; start += 3600) {
    const { traffic, waf } = generateTraffic(start, Math.min(start + 3600, to), hosts);
    await insertTrafficEvents(traffic, "demo");
    await insertWafEvents(waf, "demo");
    written.traffic += traffic.length;
    written.waf += waf.length;
  }
  return written;
}

async function servedDomains(): Promise<string[]> {
  const { listProxyHosts } = await import("../models/proxy-hosts");
  const hosts = await listProxyHosts();
  return hosts.filter((host) => host.enabled).flatMap((host) => host.domains);
}

const TICK_MS = 60_000;
/** A demo left off for longer than this restarts from a window this wide, not from the beginning. */
const MAX_BACKFILL_S = 30 * 86400;

type Global = typeof globalThis & { __CPM_DEMO_TRAFFIC__?: ReturnType<typeof setInterval> };

/** Backfills downtime, then adds each minute. SQLite store only: a real ClickHouse is not ours. */
export async function startLiveDemoTraffic(): Promise<void> {
  const global = globalThis as Global;
  if (global.__CPM_DEMO_TRAFFIC__) return;
  const { usesSqliteAnalytics, isAnalyticsEnabled } = await import("../clickhouse/client");
  if (!(await usesSqliteAnalytics()) || !(await isAnalyticsEnabled())) return;
  const { latestEventTs } = await import("../clickhouse/sqlite-store");

  let last = Math.floor(Date.now() / 1000);
  const latest = latestEventTs();
  // Empty: seeded before analytics existed, or with --no-seed.
  if (latest === null || latest < last) {
    const from =
      latest === null ? last - MAX_BACKFILL_S : Math.max(latest + 1, last - MAX_BACKFILL_S);
    const written = await writeDemoTraffic(from, last, trafficShares(await servedDomains()));
    if (written.traffic > 0)
      console.log(`Demo traffic: filled ${written.traffic} events since the last run`);
  }

  global.__CPM_DEMO_TRAFFIC__ = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const from = last;
    last = now;
    void servedDomains()
      .then((domains) => writeDemoTraffic(from, now, trafficShares(domains)))
      .catch((error) => console.warn("Demo traffic tick failed:", error));
  }, TICK_MS);
  global.__CPM_DEMO_TRAFFIC__.unref?.();
}
