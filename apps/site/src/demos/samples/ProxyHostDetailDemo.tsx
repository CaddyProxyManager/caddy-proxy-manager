import {
  type HostAuditRow,
  ProxyHostDetailView,
} from "@cpm/controller/src/components/proxy-hosts/detail/ProxyHostDetailView";
import type { ProxyHost } from "@cpm/controller/src/lib/models/proxy-hosts";
import {
  healthChecksOf,
  type ProxyHostDetail,
} from "@cpm/controller/src/lib/proxy-hosts/detail-types";
import { hostProtections } from "@cpm/controller/src/lib/proxy-hosts/protections";
import { sectionSummaries } from "@cpm/controller/src/lib/proxy-hosts/section-summary";
import {
  hostStatus,
  problemsFromAttention,
} from "@cpm/controller/src/lib/proxy-hosts/traffic-status";
import { DemoSurface } from "../DemoSurface";

const HOST: ProxyHost = {
  id: 1,
  name: "App",
  description: null,
  tags: ["prod", "team:web"],
  domains: ["app.example.com", "www.app.example.com"],
  upstreams: ["http://app-1:8080", "http://app-2:8080"],
  certificateId: null,
  accessListId: null,
  sslForced: true,
  hstsEnabled: true,
  hstsSubdomains: false,
  allowWebsocket: true,
  preserveHostHeader: true,
  skipHttpsHostnameValidation: false,
  enabled: true,
  createdAt: "2026-01-04T10:00:00.000Z",
  updatedAt: "2026-02-11T11:59:56.000Z",
  customReverseProxyJson: null,
  customPreHandlersJson: null,
  customCaddyfile: null,
  authentik: null,
  loadBalancer: {
    enabled: true,
    policy: "round_robin",
    policyHeaderField: null,
    policyCookieName: null,
    policyCookieSecret: null,
    policyQueryKey: null,
    policyChoose: null,
    policyWeights: null,
    tryDuration: null,
    tryInterval: null,
    retries: null,
    activeHealthCheck: null,
    passiveHealthCheck: {
      enabled: true,
      failDuration: "30s",
      maxFails: 3,
      unhealthyStatus: null,
      unhealthyLatency: null,
      unhealthyRequestCount: null,
    },
  },
  dnsResolver: null,
  upstreamDnsResolution: null,
  geoblock: null,
  geoblockMode: "merge",
  waf: { enabled: true },
  mtls: null,
  cpmForwardAuth: null,
  forwardAuth: null,
  tailscale: null,
  redirects: [],
  rewrite: null,
  locationRules: [],
  pathAllows: [],
  pathBlocks: [],
  pathRewrites: [],
  errorPages: [],
  cache: null,
  compression: "inherit",
  discourageIndexing: false,
  maintenance: null,
  upstreamTimeouts: null,
  rateLimit: { enabled: true, zones: [] },
  crowdsec: true,
  anubis: null,
};

const NOW = Math.floor(Date.parse("2026-02-11T12:00:00.000Z") / 1000);

/** A busy afternoon, and the 5xx burst the attention list names around 10:00. */
const TIMELINE = Array.from({ length: 48 }, (_, i) => {
  const ts = NOW - 86400 + i * 1800;
  const requests = Math.round(220 + 160 * Math.sin((i / 48) * Math.PI * 2 - 1.2) + 160);
  const serverErrors = i >= 43 && i <= 46 ? 70 + (i - 43) * 12 : i % 9 === 0 ? 2 : 0;
  return { ts, requests, served: requests - serverErrors - 3, serverErrors };
});

const DETAIL: Omit<ProxyHostDetail, "audit"> = (() => {
  const attention: ProxyHostDetail["attention"] = {
    items: [
      {
        id: "burst:app.example.com",
        provider: "traffic",
        code: "serverErrorBurst",
        severity: "critical",
        values: {
          host: "app.example.com",
          errors: 342,
          share: 0.27,
          from: "2026-02-11T09:30:00.000Z",
          to: "2026-02-11T11:58:00.000Z",
          ongoing: "yes",
        },
        href: null,
        at: "2026-02-11T11:58:00.000Z",
        scope: { proxyHosts: [1] },
      },
    ],
    skipped: [],
    truncated: 0,
  };
  const totals = TIMELINE.reduce(
    (sum, b) => ({
      requests: sum.requests + b.requests,
      serverErrors: sum.serverErrors + b.serverErrors,
    }),
    { requests: 0, serverErrors: 0 },
  );
  return {
    host: HOST,
    status: hostStatus(HOST, problemsFromAttention(attention.items)),
    attention,
    traffic: {
      window: { from: NOW - 86400, to: NOW },
      totals: {
        ...totals,
        uniqueIps: 1_284,
        bytes: totals.requests * 38_000,
        mitigated: 96,
      },
      timeline: TIMELINE,
      paths: [
        { path: "/api/session", requests: 6_120, serverErrors: 301 },
        { path: "/", requests: 3_480, serverErrors: 12 },
        { path: "/assets/app.js", requests: 2_960, serverErrors: 0 },
        { path: "/api/search", requests: 1_212, serverErrors: 29 },
        { path: "/login", requests: 640, serverErrors: 0 },
      ],
      statuses: [
        { status: 200, requests: 13_904 },
        { status: 304, requests: 1_870 },
        { status: 502, requests: 312 },
        { status: 404, requests: 188 },
        { status: 503, requests: 30 },
      ],
    },
    certificate: {
      name: "app.example.com, www.app.example.com",
      managed: true,
      notAfter: "2026-04-12T08:00:00.000Z",
      daysLeft: 59,
      stage: null,
    },
    protections: hostProtections(HOST, true),
    sections: sectionSummaries(HOST, {
      certificateName: null,
      accessListName: null,
      agentNames: [],
      crowdsecActive: true,
    }),
    healthChecks: healthChecksOf(HOST),
  };
})();

const AUDIT: HostAuditRow[] = [
  {
    id: 3,
    action: "update",
    summary: "Updated proxy host App",
    actor: "avery",
    createdAt: "2026-02-11T09:26:00.000Z",
  },
  {
    id: 2,
    action: "update",
    summary: "Added upstream http://app-2:8080 to App",
    actor: "avery",
    createdAt: "2026-02-10T17:40:00.000Z",
  },
  {
    id: 1,
    action: "create",
    summary: "Created proxy host App",
    actor: "avery",
    createdAt: "2026-01-04T10:00:00.000Z",
  },
];

/** The real host page with a day of sample traffic; its upstream panel asks the shimmed action. */
export default function ProxyHostDetailDemo() {
  return (
    <DemoSurface>
      <ProxyHostDetailView
        detail={DETAIL}
        auditRows={AUDIT}
        canManage={false}
        analyticsHref={null}
        logsHref={null}
      />
    </DemoSurface>
  );
}
