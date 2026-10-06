import { useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { useFormatter, useTranslations } from "next-intl";
import { HostNotesHint } from "@cpm/controller/src/components/proxy-hosts/HostNotesField";
import {
  HostTagFilter,
  HostTagList,
} from "@cpm/controller/src/components/proxy-hosts/HostTagsField";
import { BulkActionBar } from "@cpm/controller/src/components/ui/BulkActionBar";
import {
  DataTable,
  type Column,
  useRowSelection,
} from "@cpm/controller/src/components/ui/DataTable";
import { StatTiles } from "@cpm/controller/src/components/ui/StatTiles";
import {
  CertificateDaysCell,
  HostProtectionBadges,
  HostRequestsCell,
  HostServerErrorsCell,
  HostStatusCell,
} from "@cpm/controller/src/components/proxy-hosts/HostInsightCells";
import type { HostProtections } from "@cpm/controller/src/lib/proxy-hosts/protections";
import type { HostStatus } from "@cpm/controller/src/lib/proxy-hosts/traffic-status";
import { useRouter, useSearchParams } from "../shims/next-navigation";
import { DemoSurface } from "../DemoSurface";

type Row = {
  id: number;
  domain: string;
  upstreams: string;
  certificate: string | null;
  /** Requests in the last 24h, or null when nothing was recorded for it. */
  requests: { total: number; blocked: number; serverErrors: number } | null;
  protections: HostProtections;
  /** What the list's Status column works out from traffic, signals and the certificate. */
  status: HostStatus;
  certificateDays: number | null;
  notes: string | null;
  tags: string[];
  enabled: boolean;
  maintenance?: boolean;
};

const HOSTS: Row[] = [
  {
    id: 1,
    domain: "app.example.com",
    upstreams: "http://app-1:8080 +1",
    certificate: "app.example.com",
    requests: { total: 18_412, blocked: 96, serverErrors: 1_204 },
    protections: { active: ["waf", "rateLimit"], signIn: null },
    status: { state: "problem", problem: { code: "serverErrorBurst", severity: "critical" } },
    certificateDays: 61,
    notes: null,
    tags: ["prod", "team:web"],
    enabled: true,
  },
  {
    id: 2,
    domain: "grafana.example.com",
    upstreams: "http://grafana:3000",
    certificate: "grafana.example.com",
    requests: { total: 5_730, blocked: 0, serverErrors: 3 },
    protections: { active: ["signIn"], signIn: "authentik" },
    status: { state: "maintenance", problem: null },
    certificateDays: 8,
    notes: null,
    tags: ["monitoring", "prod"],
    enabled: true,
    maintenance: true,
  },
  {
    id: 3,
    domain: "staging.example.com",
    upstreams: "http://staging:8080",
    certificate: "Wildcard *.example.com",
    requests: null,
    protections: { active: [], signIn: null },
    status: { state: "disabled", problem: null },
    certificateDays: 212,
    notes: "Off until the next release candidate. Ask Priya before turning it back on.",
    tags: ["team:web"],
    enabled: false,
  },
  {
    id: 4,
    domain: "vpn.example.com",
    upstreams: "http://headscale:8080",
    certificate: null,
    requests: { total: 812, blocked: 4, serverErrors: 0 },
    protections: { active: ["mtls", "geo"], signIn: null },
    status: { state: "healthy", problem: null },
    certificateDays: 74,
    notes: null,
    tags: [],
    enabled: true,
  },
];

const AGENTS = { total: 3, connected: 2 };

/**
 * The real table, tiles and bulk bar; the server sorts, filters and saves in the app, this
 * component does here. Enable and Disable act on the demo's own rows, without a confirmation.
 */
function ProxyHostsTableDemoContent() {
  const t = useTranslations("proxyHosts");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const [hosts, setHosts] = useState(HOSTS);
  const router = useRouter();
  const params = useSearchParams();
  // Busiest first, as the app sorts it with analytics on.
  const sortBy = params.get("sortBy") ?? "requests";
  const sortDir = params.get("sortDir") === "asc" ? "asc" : "desc";
  const state =
    params.get("state") === "enabled" || params.get("state") === "disabled"
      ? (params.get("state") as "enabled" | "disabled")
      : "all";
  const tag = params.get("tag");
  const allTags = [...new Set(hosts.flatMap((h) => h.tags))].sort();

  const counts = {
    total: hosts.length,
    enabled: hosts.filter((h) => h.enabled).length,
    disabled: hosts.filter((h) => !h.enabled).length,
  };
  const traffic = hosts.reduce(
    (sum, h) => ({
      total: sum.total + (h.requests?.total ?? 0),
      blocked: sum.blocked + (h.requests?.blocked ?? 0),
    }),
    { total: 0, blocked: 0 },
  );
  const format = useFormatter();
  const busiest = Math.max(1, ...hosts.map((h) => h.requests?.total ?? 0));

  const rows = useMemo(() => {
    const filtered = hosts.filter(
      (h) =>
        (state === "all" || h.enabled === (state === "enabled")) && (!tag || h.tags.includes(tag)),
    );
    const sorted = [...filtered].sort((a, b) =>
      sortBy === "requests"
        ? (a.requests?.total ?? 0) - (b.requests?.total ?? 0)
        : sortBy === "status"
          ? Number(a.enabled) - Number(b.enabled)
          : a.domain.localeCompare(b.domain),
    );
    return sortDir === "desc" ? sorted.reverse() : sorted;
  }, [hosts, sortBy, sortDir, state, tag]);

  const [selectedKeys, setSelectedKeys] = useRowSelection(rows, "id");
  const setEnabled = (enabled: boolean) => {
    setHosts((all) => all.map((h) => (selectedKeys.has(String(h.id)) ? { ...h, enabled } : h)));
    setSelectedKeys(new Set());
  };

  function setTag(value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set("tag", value);
    else next.delete("tag");
    router.push(`${location.pathname}?${next.toString()}`);
  }

  function setState(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("state");
    else next.set("state", value);
    router.push(`${location.pathname}?${next.toString()}`);
  }

  const columns: Column<Row>[] = [
    {
      id: "domain",
      label: t("nameDomain"),
      sortKey: "domain",
      // The docs column is narrower than the app's, so protections ride under the domain and the
      // agents column is left out.
      render: (r) => (
        <VStack gap={1}>
          <VStack gap={0}>
            <HStack gap={1} vAlign="center">
              <Text type="body" size="sm" weight="semibold">
                {r.domain}
              </Text>
              <HostNotesHint notes={r.notes} />
            </HStack>
            <Text type="code" size="sm" color="secondary">
              {r.upstreams}
            </Text>
            <HostTagList tags={r.tags} />
          </VStack>
          <HostProtectionBadges protections={r.protections} />
        </VStack>
      ),
    },
    {
      id: "requests",
      label: t("requests24h"),
      sortKey: "requests",
      align: "right",
      width: 128,
      render: (r) => (
        <HostRequestsCell
          requests={r.requests?.total ?? 0}
          blocked={r.requests?.blocked ?? 0}
          share={(r.requests?.total ?? 0) / busiest}
        />
      ),
    },
    {
      id: "serverErrors",
      label: t("detail.serverErrors"),
      align: "right",
      width: 72,
      render: (r) => (
        <HostServerErrorsCell
          serverErrors={r.requests?.serverErrors ?? 0}
          requests={r.requests?.total ?? 0}
        />
      ),
    },
    {
      id: "certificate",
      label: t("insights.certificate"),
      width: 96,
      render: (r) => <CertificateDaysCell days={r.certificateDays} name={r.certificate} />,
    },
    {
      id: "status",
      label: tCommon("status"),
      sortKey: "status",
      width: 148,
      render: (r) => (
        <HostStatusCell
          status={
            !r.enabled
              ? { state: "disabled", problem: null }
              : r.status.state === "disabled"
                ? { state: "healthy", problem: null }
                : r.status
          }
        />
      ),
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
              label: tNav("proxyHosts"),
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
              label: tNav("certificates"),
              value: hosts.filter((h) => h.certificate).length,
              note: t("certificatesNote", { count: hosts.filter((h) => h.certificate).length }),
            },
            {
              id: "agents",
              label: tNav("agents"),
              value: AGENTS.total,
              note: t("agentsConnectedNote", { count: AGENTS.connected }),
              accent: { label: t("someAgentsOffline"), variant: "warning" },
            },
          ]}
        />
      </div>
      {selectedKeys.size > 0 ? (
        <BulkActionBar count={selectedKeys.size} onClear={() => setSelectedKeys(new Set())}>
          <Button variant="ghost" label={tCommon("enable")} onClick={() => setEnabled(true)} />
          <Button variant="ghost" label={tCommon("disable")} onClick={() => setEnabled(false)} />
        </BulkActionBar>
      ) : (
        <HStack gap={3} vAlign="center" wrap="wrap">
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
          <HostTagFilter tags={allTags} value={tag} onChange={setTag} />
        </HStack>
      )}
      <DataTable
        columns={columns}
        data={rows}
        keyField="id"
        sort={{ sortBy, sortDir }}
        emptyMessage={t("noProxyHostsFound")}
        rowStatus={(r) => (r.enabled ? null : { color: "gray", label: t("filterDisabled") })}
        selection={{
          selectedKeys,
          onChange: setSelectedKeys,
          rowLabel: (r) => r.domain,
        }}
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
