/**
 * What each Needs attention provider looks at. Each reads state something else already keeps (the
 * apply record, the agent registry, the certificate inventory, the GeoIP and CRS plugin rows) and
 * turns it into items; none of them changes anything.
 */

import type { TrafficSignal } from "../analytics/signals";
import {
  hasServerErrorShare,
  indexHostsByName,
  trafficHostName,
} from "../proxy-hosts/traffic-status";
import { proxyHostDetailHref } from "../proxy-hosts/editor-sections";
import type { AttentionItem, AttentionProviderId } from "./types";

export type HostRef = {
  id: number;
  name: string;
  domains: string[];
  enabled: boolean;
  certificateId: number | null;
};

export type ProviderContext = {
  now: number;
  /** Loaded once per run, by whichever provider asks first. */
  hosts: () => Promise<HostRef[]>;
};

export type ProviderResult = {
  items: AttentionItem[];
  /** Part of what the provider looks at could not be read in time. */
  partial?: boolean;
};

export type AttentionProvider = {
  id: AttentionProviderId;
  /** Looks at nothing an operator could be granted, so is not run for one. */
  adminOnly: boolean;
  run: (context: ProviderContext) => Promise<ProviderResult>;
};

/** Settings links, as `settingsHref` in the settings page builds them; a test keeps them equal. */
export const SETTINGS_LINKS = {
  geoip: "/settings/geo#geoip",
  ldap: "/settings/authentication#ldap",
} as const;

/** Reconnects take seconds; one gone longer than this is worth a look. */
export const AGENT_OFFLINE_GRACE_MS = 2 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** One host: its page. Several or none: the analytics page narrowed to the name. */
async function trafficHref(name: string, ids: readonly number[]): Promise<string> {
  if (ids.length === 1) return proxyHostDetailHref(ids[0]!);
  const { DEFAULT_EXPLORE_STATE, serializeExploreState } = await import(
    "../analytics/explore-state"
  );
  const query = serializeExploreState({
    ...DEFAULT_EXPLORE_STATE,
    filters: [{ field: "host", op: "is", value: name }],
  }).toString();
  return `/analytics${query ? `?${query}` : ""}`;
}

// ── Certificates ────────────────────────────────────────────────────────────

const certificates: AttentionProvider = {
  id: "certificates",
  adminOnly: false,
  async run({ now, hosts }) {
    const [{ listCertificateSummaries }, expiry, { isDomainCoveredByCert }] = await Promise.all([
      import("../models/certificates"),
      import("../certificates/expiry"),
      import("../certificates/domain-match"),
    ]);
    const [rows, hostRows, days] = await Promise.all([
      listCertificateSummaries(),
      hosts(),
      expiry.certificateTroubleDays(),
    ]);
    const items: AttentionItem[] = [];

    for (const row of rows) {
      const using = hostRows.filter((h) => h.certificateId === row.id).map((h) => h.id);
      if (row.sourceError) {
        items.push({
          id: `certificate-file:${row.id}`,
          provider: "certificates",
          code: "certificateFileError",
          severity: "warning",
          values: { name: row.name, error: row.sourceError },
          href: "/certificates",
          at: row.sourceReadAt,
          scope: { proxyHosts: using },
        });
      }
      const found = expiry.importedExpiry(row);
      const stage = found && expiry.certificateStage(found, days, now);
      if (!found || !stage) continue;
      items.push({
        id: `certificate:${row.id}`,
        provider: "certificates",
        code: stage === "expired" ? "certificateExpired" : "certificateExpiring",
        severity: stage === "expired" ? "critical" : "warning",
        values: {
          name: row.name,
          days: Math.max(0, expiry.daysLeft(found.notAfter, now) ?? 0),
          date: found.notAfter,
        },
        href: "/certificates",
        at: found.notAfter,
        scope: { proxyHosts: using },
      });
    }

    const managed = await expiry.managedCertificates(3000);
    for (const found of managed ?? []) {
      const stage = expiry.certificateStage(found, days, now);
      if (!stage) continue;
      const using = hostRows
        .filter(
          (h) =>
            h.certificateId === null &&
            h.domains.some((d) => isDomainCoveredByCert(d.trim().toLowerCase(), found.names)),
        )
        .map((h) => h.id);
      items.push({
        id: `certificate-managed:${found.agent ?? ""}:${found.name}`,
        provider: "certificates",
        code: stage === "expired" ? "certificateExpired" : "certificateExpiring",
        severity: stage === "expired" ? "critical" : "warning",
        values: {
          name: found.name,
          days: Math.max(0, expiry.daysLeft(found.notAfter, now) ?? 0),
          date: found.notAfter,
        },
        href: "/certificates",
        at: found.notAfter,
        scope: { proxyHosts: using },
      });
    }
    return { items, partial: managed === null };
  },
};

// ── Caddy apply ─────────────────────────────────────────────────────────────

const caddyApply: AttentionProvider = {
  id: "caddyApply",
  adminOnly: true,
  async run() {
    const [{ getApplyFailures }, { listAgents }] = await Promise.all([
      import("../caddy/apply-status"),
      import("../models/agents"),
    ]);
    const failures = await getApplyFailures();
    const rowIds = new Map((await listAgents()).map((agent) => [agent.agentId, agent.id]));
    return {
      items: Object.entries(failures).map(([key, failure]) => ({
        id: `caddy-apply:${key}`,
        provider: "caddyApply",
        code: "caddyApplyFailed",
        severity: "critical",
        values: {
          scope: failure.agent === null ? "fleet" : "agent",
          agent: failure.agent ?? "",
          error: failure.error,
        },
        errors: [{ message: failure.error, code: failure.errorCode ?? null }],
        href: rowIds.has(key) ? `/agents#agent-${rowIds.get(key)}` : "/agents",
        at: failure.at,
        scope: {},
      })),
    };
  },
};

// ── Agents ──────────────────────────────────────────────────────────────────

const agents: AttentionProvider = {
  id: "agents",
  adminOnly: false,
  async run({ now }) {
    const [{ listAgents }, { connectedAgents }, { agentStatusProblems }] = await Promise.all([
      import("../models/agents"),
      import("../agent/registry"),
      import("../notifications/agents"),
    ]);
    const live = new Map(connectedAgents().map((agent) => [agent.agentId, agent]));
    const items: AttentionItem[] = [];
    for (const agent of await listAgents()) {
      const connection = live.get(agent.agentId);
      if (!connection) {
        // Never connected, or switched off on purpose: nothing was lost.
        if (!agent.enabled || agent.lastSeenAt === null) continue;
        const lastSeen = Date.parse(agent.lastSeenAt);
        if (Number.isFinite(lastSeen) && now - lastSeen < AGENT_OFFLINE_GRACE_MS) continue;
        items.push({
          id: `agent-offline:${agent.id}`,
          provider: "agents",
          code: "agentOffline",
          severity: "warning",
          values: { agent: agent.name, since: agent.lastSeenAt },
          href: "/agents",
          at: agent.lastSeenAt,
          scope: { agent: agent.id },
        });
        continue;
      }
      for (const [problem, { state, detail }] of agentStatusProblems(connection.status)) {
        if (state !== "failed") continue;
        items.push({
          id: `agent-problem:${agent.id}:${problem}`,
          provider: "agents",
          code: "agentProblem",
          severity: "warning",
          values: { agent: agent.name, problem, detail: detail ?? "" },
          href: "/agents",
          at: iso(connection.lastSeenAt),
          scope: { agent: agent.id },
        });
      }
    }
    return { items };
  },
};

// ── Traffic ─────────────────────────────────────────────────────────────────

export async function signalItems(
  signals: readonly TrafficSignal[],
  hostRows: readonly HostRef[],
): Promise<AttentionItem[]> {
  const index = indexHostsByName(hostRows);
  const items: AttentionItem[] = [];
  for (const signal of signals) {
    const name = signal.host === null ? null : trafficHostName(signal.host);
    const ids = name === null ? [] : (index.get(name) ?? []);
    // A name no host serves is still traffic someone sent, but only an administrator can act.
    const scope = { proxyHosts: ids };
    switch (signal.kind) {
      case "serverErrorBurst":
        items.push({
          id: `burst:${signal.host}:${signal.from}`,
          provider: "traffic",
          code: "serverErrorBurst",
          severity: signal.severity,
          values: {
            host: signal.host,
            errors: signal.errors,
            share: signal.share,
            from: iso(signal.from * 1000),
            to: iso(signal.to * 1000),
            ongoing: signal.ongoing ? "yes" : "no",
          },
          href: await trafficHref(name ?? signal.host, ids),
          at: iso(signal.to * 1000),
          scope,
        });
        break;
      case "mitigationSpike":
        items.push({
          id: `spike:${signal.host ?? "*"}`,
          provider: "traffic",
          code: signal.host === null ? "mitigationSpikeFleet" : "mitigationSpike",
          severity: signal.severity,
          values: {
            host: signal.host ?? "",
            mitigated: signal.mitigated,
            ratio: signal.ratio === null ? 0 : Math.round(signal.ratio * 10) / 10,
          },
          href:
            signal.host === null
              ? "/analytics?log=mitigated"
              : await trafficHref(name ?? signal.host, ids),
          at: null,
          scope: signal.host === null ? {} : scope,
        });
        break;
      case "blockedConcentration":
        items.push({
          id: `blocked:${signal.host}:${signal.outcome}:${signal.path}`,
          provider: "traffic",
          code: "blockedConcentration",
          severity: signal.severity,
          values: {
            host: signal.host,
            path: signal.path,
            outcome: signal.outcome,
            requests: signal.requests,
          },
          href: await trafficHref(name ?? signal.host, ids),
          at: null,
          scope,
        });
        break;
    }
  }
  return items;
}

/** Hosts answering 5xx often enough to matter that no burst already names. */
export function serverErrorShareItems(
  traffic: ReadonlyMap<number, { total: number; serverErrors: number }>,
  hostRows: readonly HostRef[],
  covered: ReadonlySet<number>,
): AttentionItem[] {
  return hostRows.flatMap((host) => {
    const row = traffic.get(host.id);
    if (!host.enabled || !row || covered.has(host.id) || !hasServerErrorShare(row)) return [];
    return [
      {
        id: `error-share:${host.id}`,
        provider: "traffic",
        code: "serverErrorShare",
        severity: "warning",
        values: { host: host.name, errors: row.serverErrors, share: row.serverErrors / row.total },
        href: proxyHostDetailHref(host.id),
        at: null,
        scope: { proxyHosts: [host.id] },
      } satisfies AttentionItem,
    ];
  });
}

const traffic: AttentionProvider = {
  id: "traffic",
  adminOnly: false,
  async run({ now, hosts }) {
    const [{ detectTrafficSignals }, { getTrafficByProxyHost }] = await Promise.all([
      import("../analytics/signals"),
      import("../analytics/db"),
    ]);
    const to = Math.floor(now / 1000);
    const hostRows = await hosts();
    const [found, totals] = await Promise.all([
      detectTrafficSignals({ budgetMs: 3500, now: to }),
      getTrafficByProxyHost(to - 86400, to, hostRows),
    ]);
    if (!found.available) return { items: [] };
    const items = await signalItems(found.signals, hostRows);
    const covered = new Set(
      items.filter((i) => i.code === "serverErrorBurst").flatMap((i) => i.scope.proxyHosts ?? []),
    );
    items.push(...serverErrorShareItems(totals.byHost, hostRows, covered));
    return { items, partial: found.skipped.length > 0 };
  },
};

// ── LDAP ────────────────────────────────────────────────────────────────────

const ldap: AttentionProvider = {
  id: "ldap",
  adminOnly: true,
  async run({ now }) {
    const [{ listEnabledLdapDirectories }, { checkLdapDirectories }] = await Promise.all([
      import("../models/ldap-directories"),
      import("../ldap/health"),
    ]);
    const directories = await listEnabledLdapDirectories();
    const ldapChecks = await checkLdapDirectories(directories, now);
    return {
      items: directories.flatMap((directory) => {
        const failure = ldapChecks.get(directory.id)?.failure;
        if (!failure) return [];
        return [
          {
            id: `ldap:${directory.id}`,
            provider: "ldap",
            code: "ldapUnreachable",
            severity: "warning",
            values: { name: directory.name, stage: failure },
            href: SETTINGS_LINKS.ldap,
            at: iso(ldapChecks.get(directory.id)?.at ?? now),
            scope: {},
          } satisfies AttentionItem,
        ];
      }),
    };
  },
};

// ── Accounts ────────────────────────────────────────────────────────────────

const accounts: AttentionProvider = {
  id: "accounts",
  adminOnly: true,
  async run({ now }) {
    const [{ listUsers }, { accountKey, lockedAccounts }, { disabledByFailedSignIns }] =
      await Promise.all([
        import("../models/user"),
        import("../auth/rate-limit"),
        import("../auth/account-failures"),
      ]);
    const users = await listUsers();
    // Keys include names nobody owns; only real accounts are worth an administrator's look.
    const byKey = new Map(
      users.flatMap((user) => [
        [accountKey(user.email), user] as const,
        ...(user.username ? [[accountKey(user.username), user] as const] : []),
      ]),
    );
    const told = new Set<number>();
    const items: AttentionItem[] = [];
    for (const { account, until } of lockedAccounts(now)) {
      const user = byKey.get(account);
      if (!user) continue;
      if (user.status !== "active" || told.has(user.id)) continue;
      told.add(user.id);
      items.push({
        id: `account-locked:${user.id}`,
        provider: "accounts",
        code: "accountLocked",
        severity: "info",
        values: { email: user.email, until: iso(until) },
        href: "/users",
        at: iso(now),
        scope: {},
      });
    }
    const disabled = users.filter((user) => user.status === "disabled");
    const auto = await disabledByFailedSignIns(disabled.map((user) => user.id));
    for (const user of disabled) {
      if (!auto.has(user.id)) continue;
      items.push({
        id: `account-disabled:${user.id}`,
        provider: "accounts",
        code: "accountDisabled",
        severity: "warning",
        values: { email: user.email },
        href: "/users",
        at: user.updatedAt ?? null,
        scope: {},
      });
    }
    return { items };
  },
};

// ── L4 ports ────────────────────────────────────────────────────────────────

const l4Ports: AttentionProvider = {
  id: "l4Ports",
  adminOnly: true,
  async run() {
    const [{ tryGetAgentStatus }, { getL4PortsDiff, getL4PortsStatus }] = await Promise.all([
      import("../agent/client"),
      import("../l4/ports"),
    ]);
    // With no agent every port looks pending; the agent being gone is the item for that.
    if (!(await tryGetAgentStatus())) return { items: [] };
    const [diff, status] = await Promise.all([getL4PortsDiff(), getL4PortsStatus()]);
    if (status.state === "failed") {
      return {
        items: [
          {
            id: "l4-ports",
            provider: "l4Ports",
            code: "l4PortsFailed",
            severity: "critical",
            values: { error: status.error ?? status.message ?? "" },
            href: "/l4-proxy-hosts",
            at: status.triggeredAt ?? null,
            scope: {},
          },
        ],
      };
    }
    if (!diff.needsApply || status.state === "pending" || status.state === "applying") {
      return { items: [] };
    }
    return {
      items: [
        {
          id: "l4-ports",
          provider: "l4Ports",
          code: "l4PortsPending",
          severity: "warning",
          values: { count: diff.requiredPorts.length },
          href: "/l4-proxy-hosts",
          at: null,
          scope: {},
        },
      ],
    };
  },
};

// ── CRS plugins ─────────────────────────────────────────────────────────────

const crsPlugins: AttentionProvider = {
  id: "crsPlugins",
  adminOnly: true,
  async run() {
    const { crsPluginLoadFailures, listCrsPlugins } = await import("../models/crs-plugins");
    const [failures, plugins] = await Promise.all([crsPluginLoadFailures(), listCrsPlugins()]);
    const names = new Map(plugins.map((plugin) => [plugin.id, plugin.name]));
    return {
      items: [...failures].map(([id, failure]) => ({
        id: `crs-plugin:${id}`,
        provider: "crsPlugins",
        code: "crsPluginDisabled",
        severity: "warning",
        values: { name: names.get(id) ?? String(id), version: failure.version },
        href: "/waf",
        at: failure.at,
        scope: {},
      })),
    };
  },
};

// ── GeoIP ───────────────────────────────────────────────────────────────────

const geoip: AttentionProvider = {
  id: "geoip",
  adminOnly: true,
  async run() {
    const [{ geoipEnabled }, { getGeoipDownloadState }] = await Promise.all([
      import("../agent/geoip"),
      import("../geoip/updater"),
    ]);
    if (!(await geoipEnabled())) return { items: [] };
    const state = await getGeoipDownloadState();
    if (!state.error && state.failures.length === 0) return { items: [] };
    return {
      items: [
        {
          id: "geoip",
          provider: "geoip",
          code: "geoipFailing",
          severity: "warning",
          values: {
            error: state.error ?? state.failures.map((failure) => failure.message).join("; "),
          },
          // A state stored before failures were kept has only the joined English.
          ...(state.failures.length > 0 && {
            errors: state.failures.map((failure) => ({
              message: failure.message,
              code: failure.code,
              edition: failure.edition,
            })),
          }),
          href: SETTINGS_LINKS.geoip,
          at: state.ranAt,
          scope: {},
        },
      ],
    };
  },
};

// ── Security ────────────────────────────────────────────────────────────────

/** Access lists with a country, continent or ASN rule in force. */
async function listsWithGeoRules(now = Date.now()): Promise<number> {
  const [{ default: db }, { accessListIpRules }, { isGeoRule, isRuleActive }] = await Promise.all([
    import("../db"),
    import("../db/schema"),
    import("../access-lists/rules"),
  ]);
  const rules = await db
    .select({
      accessListId: accessListIpRules.accessListId,
      country: accessListIpRules.country,
      continent: accessListIpRules.continent,
      asn: accessListIpRules.asn,
      expiresAt: accessListIpRules.expiresAt,
    })
    .from(accessListIpRules);
  return new Set(
    rules.filter((rule) => isGeoRule(rule) && isRuleActive(rule, now)).map((r) => r.accessListId),
  ).size;
}

const security: AttentionProvider = {
  id: "security",
  adminOnly: true,
  async run() {
    const [{ getWafSettings }, { listActiveBlockedSources }, imageBuild] = await Promise.all([
      import("../settings"),
      import("../models/blocked-sources"),
      import("../caddy/image-build"),
    ]);
    const [waf, blocked] = await Promise.all([getWafSettings(), listActiveBlockedSources()]);
    const items: AttentionItem[] = [];
    // Easy to leave on after tuning, and it reads as protected while blocking nothing.
    if (waf?.enabled && waf.mode === "DetectionOnly") {
      items.push({
        id: "waf:detection-only",
        provider: "security",
        code: "wafDetectionOnly",
        severity: "info",
        values: {},
        href: "/waf",
        at: null,
        scope: {},
      });
    }
    const geo = blocked.filter((source) => source.kind !== "ip" && source.kind !== "cidr");
    const geoRuleLists = await listsWithGeoRules();
    const geoUsable =
      geo.length > 0 || geoRuleLists > 0
        ? imageBuild.isFeatureUsable(await imageBuild.getCaddyModuleAvailability(), "geoblock")
        : true;
    // A deny rule by country left out lets that country in, so it is a warning like the deny list.
    if (geoRuleLists > 0 && !geoUsable) {
      items.push({
        id: "access-lists:geo-unenforced",
        provider: "security",
        code: "accessListGeoUnenforced",
        severity: "warning",
        values: { count: geoRuleLists },
        href: "/access-lists",
        at: null,
        scope: {},
      });
    }
    if (geo.length > 0) {
      if (!geoUsable) {
        items.push({
          id: "blocked-sources:unenforced",
          provider: "security",
          code: "blockedSourcesUnenforced",
          severity: "warning",
          values: { count: geo.length },
          href: "/security/blocked-sources",
          at: null,
          scope: {},
        });
      }
    }
    return { items };
  },
};

export const ATTENTION_PROVIDER_LIST: readonly AttentionProvider[] = [
  certificates,
  caddyApply,
  agents,
  traffic,
  ldap,
  accounts,
  l4Ports,
  crsPlugins,
  geoip,
  security,
];
