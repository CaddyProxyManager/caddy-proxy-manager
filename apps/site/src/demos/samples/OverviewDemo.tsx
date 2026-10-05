import OverviewClient, {
  type OverviewPayload,
} from "@cpm/controller/src/app/(dashboard)/OverviewClient";
import type { AttentionList } from "@cpm/controller/src/lib/attention/types";
import type { SetupChecklist } from "@cpm/controller/src/lib/setup-checklist/steps";
import { DemoSurface } from "../DemoSurface";
import { t } from "../catalog";

const SERVER_EVENTS_BY_HOUR: Record<number, number> = {
  9: 2,
  10: 1,
  13: 3,
  17: 4,
  18: 2,
  19: 1,
  21: 3,
  22: 1,
};

/** Shaped like a home server's day rather than a flat line. */
const TIMELINE: OverviewPayload["timeline"] = (() => {
  const start = Math.floor(Date.parse("2026-02-11T12:00:00.000Z") / 1000) - 24 * 3600;
  const perHour = [
    980, 760, 610, 540, 520, 610, 1180, 2140, 3020, 3310, 3180, 3240, 3090, 2980, 3120, 3260, 3410,
    3980, 4620, 4910, 4780, 4210, 2960, 1740,
  ];
  return perHour.map((total, hour) => ({
    ts: start + hour * 3600,
    total,
    // The scanner sweep behind the blocked tile.
    blocked: hour >= 2 && hour <= 4 ? 140 - (hour - 2) * 30 : 4,
    clientErrors: Math.round(total * 0.021) + (hour >= 2 && hour <= 4 ? 90 : 0),
    serverErrors: hour === 18 || hour === 19 ? 140 : Math.round(total * 0.0008),
    bytes: total * 41_000,
    // Seventeen changes, matching the tile; the cluster at 17:00 precedes the 5xx spike.
    serverEvents: SERVER_EVENTS_BY_HOUR[hour] ?? 0,
  }));
})();

/**
 * As `traffic_events` stores them (no upstream or duration). Audit timestamps interleave on
 * purpose, to show the log blending both.
 */
const EVENTS: OverviewPayload["events"] = [
  {
    ts: 1770811200,
    clientIp: "203.0.113.24",
    countryCode: "US",
    host: "media.example.com",
    method: "GET",
    uri: "/library/sections/2/all",
    status: 200,
    proto: "HTTP/2.0",
    bytesSent: 49_152,
    isBlocked: false,
  },
  {
    ts: 1770811198,
    clientIp: "198.51.100.7",
    countryCode: "GB",
    host: "git.example.com",
    method: "POST",
    uri: "/avery/infra/git-upload-pack",
    status: 200,
    proto: "HTTP/2.0",
    bytesSent: 1_258_291,
    isBlocked: false,
  },
  {
    ts: 1770811195,
    clientIp: "10.0.2.51",
    countryCode: null,
    host: "app.example.com",
    method: "GET",
    uri: "/v1/devices/sync",
    status: 502,
    proto: "HTTP/1.1",
    bytesSent: 0,
    isBlocked: false,
  },
  {
    ts: 1770811191,
    clientIp: "45.148.10.62",
    countryCode: "NL",
    host: "status.example.com",
    method: "GET",
    uri: "/.env",
    status: 403,
    proto: "HTTP/1.1",
    bytesSent: 512,
    isBlocked: true,
  },
  {
    ts: 1770811188,
    clientIp: "10.0.2.14",
    countryCode: null,
    host: "home.example.com",
    method: "GET",
    uri: "/static/frontend_latest/app.js",
    status: 304,
    proto: "HTTP/3.0",
    bytesSent: 0,
    isBlocked: false,
  },
  {
    ts: 1770811184,
    clientIp: "203.0.113.88",
    countryCode: "US",
    host: "grafana.example.com",
    method: "GET",
    uri: "/api/dashboards/uid/caddy",
    status: 200,
    proto: "HTTP/2.0",
    bytesSent: 98_304,
    isBlocked: false,
  },
];

const PREVIEW: OverviewPayload = {
  summary: {
    totalRequests: 68_620,
    uniqueIps: 1_284,
    blockedRequests: 412,
    blockedPercent: 0.6,
    bytesServed: 2_813_420_000,
    // Not the "switch logging on" banner.
    loggingDisabled: false,
    analyticsDisabled: false,
  },
  statusClasses: { ok: 66_772, clientErrors: 1_566, serverErrors: 282, blocked: 412 },
  wafBlocked: 412,
  timeline: TIMELINE,
  events: EVENTS,
};

/** Demoable unchanged: it takes every number as a prop and imports no server action. */
/** The chart's 5xx spike, a certificate Caddy is failing to renew, and the scanner sweep. */
const ATTENTION: AttentionList = {
  items: [
    {
      id: "burst:git.example.com",
      provider: "traffic",
      code: "serverErrorBurst",
      severity: "warning",
      values: {
        host: "git.example.com",
        errors: 280,
        share: 0.062,
        from: "2026-02-11T06:00:00.000Z",
        to: "2026-02-11T07:58:00.000Z",
        ongoing: "no",
      },
      href: null,
      at: "2026-02-11T07:58:00.000Z",
      scope: {},
    },
    {
      id: "certificate-managed:edge-fra:media.example.com",
      provider: "certificates",
      code: "certificateExpiring",
      severity: "warning",
      values: { name: "media.example.com", days: 6, date: "2026-02-17T09:12:00.000Z" },
      href: null,
      at: "2026-02-17T09:12:00.000Z",
      scope: {},
    },
    {
      id: "blocked:git.example.com:waf:/wp-login.php",
      provider: "traffic",
      code: "blockedConcentration",
      severity: "info",
      values: { host: "git.example.com", path: "/wp-login.php", outcome: "waf", requests: 312 },
      href: null,
      at: null,
      scope: {},
    },
  ],
  skipped: [],
  truncated: 0,
};

const CHECKLIST: SetupChecklist = {
  hidden: false,
  steps: [
    { step: "certificate", detected: true, markedDone: false },
    { step: "proxyHost", detected: true, markedDone: false },
    { step: "analytics", detected: true, markedDone: false },
    { step: "secondUser", detected: false, markedDone: false },
    { step: "sso", detected: false, markedDone: false },
  ],
};

export default function OverviewDemo() {
  return (
    <DemoSurface>
      <OverviewClient
        userName="Avery"
        stats={[
          // Named as the overview page names them.
          { label: t("nav.proxyHosts"), icon: "proxyHosts", count: 11, total: 12, href: "#" },
          { label: t("nav.certificates"), icon: "certificates", count: 9, href: "#" },
          { label: t("nav.accessLists"), icon: "accessLists", count: 3, href: "#" },
        ]}
        trafficSummary={{ totalRequests: 68_620, blockedPercent: 0.6 }}
        serverEventCount={17}
        previewPayload={PREVIEW}
        previewAttention={ATTENTION}
        previewChecklist={CHECKLIST}
        recentEvents={[
          {
            id: 9,
            action: "update",
            entityType: "proxy_host",
            actor: "avery",
            summary: "Enabled the WAF on grafana.example.com",
            createdAt: "2026-02-11T11:59:59.000Z",
          },
          {
            id: 8,
            action: "update",
            entityType: "proxy_host",
            actor: "avery",
            summary: "Added upstream http://app-2:8080 to app.example.com",
            createdAt: "2026-02-11T11:59:56.000Z",
          },
          {
            id: 7,
            action: "create",
            entityType: "l4_proxy_host",
            actor: "avery",
            summary: "Created L4 proxy host postgres (5432/tcp)",
            createdAt: "2026-02-11T11:59:50.000Z",
          },
          {
            id: 6,
            action: "renew",
            entityType: "certificate",
            actor: null,
            summary: "Issued client certificate backup-runner",
            createdAt: "2026-02-11T11:59:46.000Z",
          },
          {
            id: 5,
            action: "delete",
            entityType: "access_list",
            actor: "avery",
            summary: "Removed old-laptop from the Staging access list",
            createdAt: "2026-02-11T11:59:42.000Z",
          },
        ]}
      />
    </DemoSurface>
  );
}
