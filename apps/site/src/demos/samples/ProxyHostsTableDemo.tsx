import { useMemo } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { useFormatter, useTranslations } from "next-intl";
import { DataTable, type Column } from "@cpm/controller/src/components/ui/DataTable";
import { StatTiles } from "@cpm/controller/src/components/ui/StatTiles";
import { StatusChip } from "@cpm/controller/src/components/ui/StatusChip";
import { useRouter, useSearchParams } from "../shims/next-navigation";
import { DemoSurface } from "../DemoSurface";

type Row = {
  id: number;
  domain: string;
  upstreams: string;
  certificate: string | null;
  /** Agent names the host is pinned to; empty means every agent serves it. */
  agents: string[];
  /** Requests in the last 24h, or null when nothing was recorded for it. */
  requests: { total: number; blocked: number } | null;
  protections: string[];
  enabled: boolean;
};

const HOSTS: Row[] = [
  {
    id: 1,
    domain: "app.example.com",
    upstreams: "http://app-1:8080 +1",
    certificate: "app.example.com",
    agents: [],
    requests: { total: 18_412, blocked: 96 },
    protections: ["WAF", "LB"],
    enabled: true,
  },
  {
    id: 2,
    domain: "grafana.example.com",
    upstreams: "http://grafana:3000",
    certificate: "grafana.example.com",
    agents: ["edge-fra"],
    requests: { total: 5_730, blocked: 0 },
    protections: ["Authentik"],
    enabled: true,
  },
  {
    id: 3,
    domain: "staging.example.com",
    upstreams: "http://staging:8080",
    certificate: "Wildcard *.example.com",
    agents: ["lab-nuc"],
    requests: null,
    protections: [],
    enabled: false,
  },
  {
    id: 4,
    domain: "vpn.example.com",
    upstreams: "http://headscale:8080",
    certificate: null,
    agents: ["edge-fra", "edge-ams"],
    requests: { total: 812, blocked: 4 },
    protections: ["mTLS", "Tailnet"],
    enabled: true,
  },
];

const AGENTS = { total: 3, connected: 2 };

/** The real table and tiles; the server sorts and filters in the app, this component does here. */
function ProxyHostsTableDemoContent() {
  const t = useTranslations("proxyHosts");
  const router = useRouter();
  const params = useSearchParams();
  const sortBy = params.get("sortBy") ?? "domain";
  const sortDir = params.get("sortDir") === "desc" ? "desc" : "asc";
  const state =
    params.get("state") === "enabled" || params.get("state") === "disabled"
      ? (params.get("state") as "enabled" | "disabled")
      : "all";

  const counts = {
    total: HOSTS.length,
    enabled: HOSTS.filter((h) => h.enabled).length,
    disabled: HOSTS.filter((h) => !h.enabled).length,
  };
  const traffic = HOSTS.reduce(
    (sum, h) => ({
      total: sum.total + (h.requests?.total ?? 0),
      blocked: sum.blocked + (h.requests?.blocked ?? 0),
    }),
    { total: 0, blocked: 0 },
  );
  const format = useFormatter();

  const rows = useMemo(() => {
    const filtered =
      state === "all" ? HOSTS : HOSTS.filter((h) => h.enabled === (state === "enabled"));
    const sorted = [...filtered].sort((a, b) =>
      sortBy === "status"
        ? Number(b.enabled) - Number(a.enabled)
        : a.domain.localeCompare(b.domain),
    );
    return sortDir === "desc" ? sorted.reverse() : sorted;
  }, [sortBy, sortDir, state]);

  function setState(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("state");
    else next.set("state", value);
    router.push(`${location.pathname}?${next.toString()}`);
  }

  const columns: Column<Row>[] = [
    {
      id: "domain",
      label: "Domain",
      sortKey: "domain",
      // The docs column is narrower than the app's, so protections ride under the domain.
      render: (r) => (
        <VStack gap={1}>
          <VStack gap={0}>
            <Text type="body" size="sm" weight="semibold">
              {r.domain}
            </Text>
            <Text type="code" size="xsm" color="secondary">
              {r.upstreams}
            </Text>
          </VStack>
          {r.protections.length > 0 && (
            <HStack gap={1} wrap="wrap">
              {r.protections.map((p) => (
                <Badge key={p} label={p} />
              ))}
            </HStack>
          )}
        </VStack>
      ),
    },
    {
      id: "tls",
      label: t("tls"),
      width: 132,
      render: (r) =>
        r.certificate ? (
          <Text type="body" size="sm" maxLines={1}>
            {r.certificate}
          </Text>
        ) : (
          <Text type="body" size="xsm" color="secondary">
            &mdash;
          </Text>
        ),
    },
    {
      id: "agents",
      label: t("assignedAgents"),
      width: 112,
      render: (r) => (
        <Text type="body" size="sm" color="secondary" maxLines={1}>
          {r.agents.length === 0 ? t("servedByEveryAgent") : r.agents.join(", ")}
        </Text>
      ),
    },
    {
      id: "requests",
      label: t("requests24h"),
      align: "right",
      width: 104,
      render: (r) =>
        r.requests ? (
          <VStack gap={0} hAlign="end">
            <Text type="code" size="sm">
              {format.number(r.requests.total)}
            </Text>
            {r.requests.blocked > 0 && (
              <Text type="supporting" color="secondary">
                {t("blockedCount", { count: format.number(r.requests.blocked) })}
              </Text>
            )}
          </VStack>
        ) : (
          <Text type="body" size="xsm" color="secondary">
            &mdash;
          </Text>
        ),
    },
    {
      id: "status",
      label: "Status",
      sortKey: "status",
      width: 96,
      render: (r) => <StatusChip status={r.enabled ? "active" : "inactive"} />,
    },
  ];

  return (
    <VStack gap={4}>
      {/* Desktop only, as ListPageHeader has them: a phone list is for finding a row. */}
      <div className="cpm-desktop-only">
        <StatTiles
          tiles={[
            {
              id: "hosts",
              label: t("proxyHosts"),
              value: counts.total,
              note: t("enabledDisabledNote", {
                enabled: counts.enabled,
                disabled: counts.disabled,
              }),
            },
            {
              id: "requests",
              label: t("requests24h"),
              value: format.number(traffic.total),
              note: t("blockedShareNote", {
                percent: ((traffic.blocked / traffic.total) * 100).toFixed(1),
              }),
            },
            {
              id: "certificates",
              label: t("certificates"),
              value: HOSTS.filter((h) => h.certificate).length,
              note: t("certificatesNote", { count: HOSTS.filter((h) => h.certificate).length }),
            },
            {
              id: "agents",
              label: t("assignedAgents"),
              value: AGENTS.total,
              note: t("agentsConnectedNote", { count: AGENTS.connected }),
              accent: { label: t("someAgentsOffline"), variant: "warning" },
            },
          ]}
        />
      </div>
      <TabList value={state} onChange={setState}>
        <Tab value="all" label={t("filterAll")} endContent={<Badge label={counts.total} />} />
        <Tab
          value="enabled"
          label={t("filterEnabled")}
          endContent={<Badge label={counts.enabled} />}
        />
        <Tab
          value="disabled"
          label={t("filterDisabled")}
          endContent={<Badge label={counts.disabled} />}
        />
      </TabList>
      <DataTable
        columns={columns}
        data={rows}
        keyField="id"
        sort={{ sortBy, sortDir }}
        emptyMessage="No proxy hosts yet"
        rowStatus={(r) => (r.enabled ? null : { color: "gray", label: "Disabled" })}
      />
    </VStack>
  );
}

/** Content goes inside DemoSurface, which provides the message catalog it translates from. */
export default function ProxyHostsTableDemo() {
  return (
    <DemoSurface>
      <ProxyHostsTableDemoContent />
    </DemoSurface>
  );
}
