"use client";

import { clearEditorLink } from "@/components/host-review/section-link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Globe,
  ArrowRight,
  Shield,
  Bug,
  MapPin,
  Scale,
  KeyRound,
  UserCheck,
  CornerRightDown,
  Replace,
  Ban,
  GitBranch,
  ShieldCheck,
  LogIn,
  Network,
} from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { ACCENTS } from "@/components/ui/accent";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Icon } from "@astryxdesign/core/Icon";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Switch } from "@astryxdesign/core/Switch";
import { ReachabilityDialog } from "@/components/certificates/ReachabilityDialog";
import { HostNotesHint } from "@/components/proxy-hosts/HostNotesField";
import { HostTagFilter, HostTagList } from "@/components/proxy-hosts/HostTagsField";
import { duplicateProxyHostDraft } from "@/lib/proxy-hosts/duplicate";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import {
  CertificateDaysCell,
  HostProtectionBadges,
  HostRequestsCell,
  HostServerErrorsCell,
  HostStatusCell,
} from "@/components/proxy-hosts/HostInsightCells";
import type { ListInsights } from "@/lib/proxy-hosts/list-insights";
import {
  isEditorSection,
  proxyHostDetailHref,
  type EditorSection,
} from "@/lib/proxy-hosts/editor-sections";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { AccessList } from "@/lib/models/access-lists";
import type { CertificatePickerOption } from "@/lib/certificates/api";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import type { CaCertificate } from "@/lib/models/ca-certificates";
import type { AuthentikSettings, ForwardAuthSettings } from "@/lib/settings";
import type { TailscaleHostDefaults } from "@/components/proxy-hosts/TailscaleFields";
import type { MtlsRole } from "@/lib/models/mtls-roles";
import type { IssuedClientCertificate } from "@/lib/models/issued-client-certificates";
import { setProxyHostMaintenanceAction, toggleProxyHostAction } from "./actions";
import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { SearchField } from "@/components/ui/SearchField";
import { DataTable, type Column, useRowSelection } from "@/components/ui/DataTable";
import { ProxyHostBulkActions } from "@/components/proxy-hosts/ProxyHostBulkActions";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { StatusChip } from "@/components/ui/StatusChip";
import { useEmptyValue } from "@/components/ui/empty-value";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import {
  CreateHostDialog,
  EditHostDialog,
  DeleteHostDialog,
} from "@/components/proxy-hosts/HostDialogs";
import type { AgentOption } from "@/components/agents/AgentAssignmentFields";
import { StatTiles } from "@/components/ui/StatTiles";

type ForwardAuthUser = { id: number; email: string; name: string | null; role: string };
type ForwardAuthGroup = {
  id: number;
  name: string;
  description: string | null;
  member_count: number;
};
type ForwardAuthAccessMap = Record<number, { userIds: number[]; groupIds: number[] }>;

type Props = {
  hosts: ProxyHost[];
  certificates: CertificatePickerOption[];
  accessLists: AccessList[];
  caCertificates: CaCertificate[];
  authentikDefaults: AuthentikSettings | null;
  forwardAuthDefaults: ForwardAuthSettings | null;
  /** Prefilled into a new host's domains; empty for none. */
  defaultDomain: string;
  tailscaleDefaults: TailscaleHostDefaults | null;
  pagination: { total: number; page: number; perPage: number };
  initialSearch: string;
  /** Every tag on a host the viewer can see, for the filter. */
  tags?: string[];
  activeTag?: string | null;
  initialSort?: { sortBy: string; sortDir: "asc" | "desc" };
  mtlsRoles?: MtlsRole[];
  issuedClientCerts?: IssuedClientCertificate[];
  forwardAuthUsers?: ForwardAuthUser[];
  forwardAuthGroups?: ForwardAuthGroup[];
  forwardAuthAccessMap?: ForwardAuthAccessMap;
  agents?: AgentOption[];
  /** A host absent from here is served by every agent. */
  agentAssignments?: Record<number, number[]>;
  /** Across everything visible, so the tabs do not count only this page. */
  counts: { total: number; enabled: number; disabled: number };
  /** Traffic columns, last 24h; unavailable when analytics is off or unreachable. */
  insights: ListInsights;
  /** Opened in the editor on arrival, from a section link on the host's page. */
  editTarget?: ProxyHost | null;
  activeState: "all" | "enabled" | "disabled";
  /** False for an operator: grants name existing hosts. Duplicating goes with it. */
  canCreate?: boolean;
  /** Custom Caddyfile and raw JSON; admin-only, enforced by the proxy host model. */
  canEditRawConfig?: boolean;
  /** This page's hosts the viewer may change; the rest get a disabled checkbox. */
  manageableIds?: number[];
};

type FeatureLabelKey =
  | "tls"
  | "features.auth"
  | "features.authentik"
  | "features.forwardAuth"
  | "features.tailnet"
  | "features.waf"
  | "features.geo"
  | "features.lb"
  | "features.mtls"
  | "redirects"
  | "features.rewrite"
  | "features.allows"
  | "features.blocks"
  | "pathRewrites";

/** `variant` marks the two meaning "traffic is being restricted". */
const FEATURES: ReadonlyArray<{
  key: string;
  labelKey: FeatureLabelKey;
  icon?: ReactNode;
  variant?: "info" | "warning";
  isOn: (host: ProxyHost) => boolean;
}> = [
  { key: "tls", labelKey: "tls", variant: "info", isOn: (h) => Boolean(h.certificateId) },
  {
    key: "auth",
    labelKey: "features.auth",
    icon: <Shield />,
    variant: "warning",
    isOn: (h) => Boolean(h.accessListId),
  },
  {
    key: "authentik",
    labelKey: "features.authentik",
    icon: <UserCheck />,
    isOn: (h) => Boolean(h.authentik?.enabled),
  },
  {
    key: "forward-auth",
    labelKey: "features.forwardAuth",
    icon: <LogIn />,
    isOn: (h) => Boolean(h.cpmForwardAuth?.enabled),
  },
  {
    key: "tailscale",
    // Unreachable from the public listener, which is otherwise invisible from the list.
    labelKey: "features.tailnet",
    icon: <Network />,
    variant: "info",
    isOn: (h) => Boolean(h.tailscale?.serve),
  },
  { key: "waf", labelKey: "features.waf", icon: <Bug />, isOn: (h) => Boolean(h.waf?.enabled) },
  {
    key: "geo",
    labelKey: "features.geo",
    icon: <MapPin />,
    isOn: (h) => Boolean(h.geoblock?.enabled),
  },
  {
    key: "lb",
    labelKey: "features.lb",
    icon: <Scale />,
    isOn: (h) => Boolean(h.loadBalancer?.enabled),
  },
  {
    key: "mtls",
    labelKey: "features.mtls",
    icon: <KeyRound />,
    isOn: (h) => Boolean(h.mtls?.enabled),
  },
  {
    key: "redirects",
    labelKey: "redirects",
    icon: <CornerRightDown />,
    isOn: (h) => h.redirects?.length > 0,
  },
  {
    key: "rewrite",
    labelKey: "features.rewrite",
    icon: <Replace />,
    isOn: (h) => Boolean(h.rewrite),
  },
  {
    key: "path-allows",
    labelKey: "features.allows",
    icon: <ShieldCheck />,
    isOn: (h) => h.pathAllows?.length > 0,
  },
  {
    key: "path-blocks",
    labelKey: "features.blocks",
    icon: <Ban />,
    isOn: (h) => h.pathBlocks?.length > 0,
  },
  {
    key: "path-rewrites",
    labelKey: "pathRewrites",
    icon: <GitBranch />,
    isOn: (h) => h.pathRewrites?.length > 0,
  },
];

/** "example.com +2" - the primary entry plus a count of the rest. */
function summarize(values: string[]) {
  return values.length > 1 ? `${values[0]} +${values.length - 1}` : values[0];
}

/** Maintenance only reads as a status while the host is serving at all. */
function HostStatus({ host }: { host: ProxyHost }) {
  const t = useTranslations("proxyHosts");
  if (host.enabled && host.maintenance?.enabled) {
    return <StatusChip status="warning" label={t("maintenanceToken")} />;
  }
  return <StatusChip status={host.enabled ? "active" : "inactive"} />;
}

/** At module scope: nested, it would be a new type each render and remount the menu mid-use. */
function HostActions({
  host,
  onToggle,
  onMaintenance,
  onEdit,
  onDuplicate,
  onDelete,
  onTestReachability,
  canCreate,
}: {
  host: ProxyHost;
  onToggle: (enabled: boolean) => void;
  onMaintenance: (enabled: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onTestReachability: () => void;
  /** Duplicating makes a new host, so it follows Create, not Edit. */
  canCreate: boolean;
}) {
  const t = useTranslations("proxyHosts");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  return (
    <HStack gap={2} vAlign="center" justify="end">
      <Switch
        label={t("enableHostLabel", { name: host.name })}
        isLabelHidden
        value={host.enabled}
        onChange={onToggle}
      />
      <MoreMenu
        label={tCommon("actionsFor", { name: host.name })}
        size="sm"
        alignment="end"
        items={[
          { label: tCommon("edit"), onClick: onEdit },
          ...(canCreate ? [{ label: tCommon("duplicate"), onClick: onDuplicate }] : []),
          host.maintenance?.enabled
            ? { label: t("turnOffMaintenance"), onClick: () => onMaintenance(false) }
            : { label: t("turnOnMaintenance"), onClick: () => onMaintenance(true) },
          // Admins only: access logs carry every client's address.
          ...(canCreate
            ? [
                {
                  label: tNav("logs"),
                  onClick: () =>
                    window.location.assign(
                      `/logs?source=access&host=${encodeURIComponent(host.domains[0] ?? "")}`,
                    ),
                },
                { label: tCommon("testReachability"), onClick: onTestReachability },
              ]
            : []),
          { type: "divider" },
          { label: tCommon("delete"), variant: "destructive", onClick: onDelete },
        ]}
      />
    </HStack>
  );
}

export default function ProxyHostsClient({
  hosts,
  certificates,
  accessLists,
  caCertificates,
  authentikDefaults,
  forwardAuthDefaults,
  defaultDomain,
  tailscaleDefaults,
  pagination,
  initialSearch,
  tags = [],
  activeTag = null,
  initialSort,
  mtlsRoles,
  issuedClientCerts,
  forwardAuthUsers,
  forwardAuthGroups,
  forwardAuthAccessMap,
  agents,
  agentAssignments,
  counts,
  insights,
  editTarget = null,
  activeState,
  canCreate = true,
  canEditRawConfig = false,
  manageableIds = [],
}: Props) {
  const t = useTranslations("proxyHosts");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const format = useAppFormatter();
  const emptyValue = useEmptyValue();
  const [createOpen, setCreateOpen] = useState(false);
  const [duplicateHost, setDuplicateHost] = useState<ProxyHost | null>(null);
  const [editHost, setEditHost] = useState<ProxyHost | null>(editTarget);
  const [editSection, setEditSection] = useState<EditorSection | null>(null);
  const [deleteHost, setDeleteHost] = useState<ProxyHost | null>(null);
  const [checkingHost, setCheckingHost] = useState<ProxyHost | null>(null);
  // Remounts CreateHostDialog on each open, resetting useFormState.
  const [dialogKey, setDialogKey] = useState(0);
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [selectedKeys, setSelectedKeys] = useRowSelection(hosts, "id");
  const manageable = new Set(manageableIds);
  const selectedHosts = hosts.filter((host) => selectedKeys.has(String(host.id)));
  // Hidden on a phone in v1: the cards have no checkboxes to select with.
  const isNarrow = useMediaQuery("(max-width: 767px)");

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSearchTerm(initialSearch);
  }, [initialSearch]);

  // The section rides in the hash, which the server never sees.
  useEffect(() => {
    if (!editTarget) return;
    const hash = window.location.hash.slice(1);
    setEditSection(isEditorSection(hash) ? hash : null);
    setEditHost(editTarget);
  }, [editTarget]);

  function closeEditor() {
    setEditHost(null);
    setEditSection(null);
    if (!searchParams.has("edit")) {
      clearEditorLink();
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete("edit");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  function handleSearchChange(value: string) {
    setSearchTerm(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value.trim()) {
        params.set("search", value.trim());
      } else {
        params.delete("search");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`);
    }, 400);
  }

  function handleTagChange(value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("tag", value);
    else params.delete("tag");
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`);
  }

  function handleStateChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") params.delete("state");
    else params.set("state", value);
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`);
  }

  const handleToggleEnabled = async (id: number, enabled: boolean) => {
    await toggleProxyHostAction(id, enabled);
  };

  const handleMaintenance = async (id: number, enabled: boolean) => {
    await setProxyHostMaintenanceAction(id, enabled);
  };

  function openDuplicate(host: ProxyHost) {
    setDuplicateHost(duplicateProxyHostDraft(host));
    setDialogKey((k) => k + 1);
    setCreateOpen(true);
  }

  const certificateNames = new Map(certificates.map((c) => [c.id, c.name]));
  const agentNames = new Map((agents ?? []).map((a) => [a.id, a.name]));
  // From the server, not the numbers: no traffic is a quiet day, not "analytics is off".
  const trafficKnown = insights.available;
  const trafficTotals = insights.available
    ? { total: insights.totals.requests, blocked: insights.totals.blocked }
    : { total: 0, blocked: 0 };
  const insightFor = (host: ProxyHost) =>
    insights.available ? insights.byHost[host.id] : undefined;
  const blockedShare =
    trafficTotals.total > 0
      ? ((trafficTotals.blocked / trafficTotals.total) * 100).toFixed(1)
      : "0.0";
  const hostsWithTls = hosts.filter((host) => host.certificateId).length;
  const connectedAgents = (agents ?? []).filter((agent) => agent.connected).length;

  const columns: Column<ProxyHost>[] = [
    {
      id: "name",
      label: t("nameDomain"),
      sortKey: "name",
      render: (host) => (
        <HStack gap={3} vAlign="center">
          <Icon icon={Globe} size="sm" color={host.enabled ? "success" : "disabled"} />
          <VStack gap={0} className="cpm-cell-lines">
            <HStack gap={1} vAlign="center">
              <AstryxLink href={proxyHostDetailHref(host.id)}>
                <Text type="body" size="sm" weight="semibold">
                  {host.name}
                </Text>
              </AstryxLink>
              <HostNotesHint notes={host.description} />
            </HStack>
            <Tooltip content={host.domains.join(", ")}>
              <Text type="code" size="xsm" color="secondary" maxLines={1}>
                {summarize(host.domains)}
              </Text>
            </Tooltip>
            <HostTagList tags={host.tags} />
          </VStack>
        </HStack>
      ),
    },
    {
      id: "target",
      label: t("upstream"),
      sortKey: "upstreams",
      render: (host) => (
        <HStack gap={2} vAlign="center">
          <Icon icon={ArrowRight} size="xsm" color="secondary" />
          <Tooltip content={host.upstreams.join(", ")}>
            <Text type="code" size="sm" weight="medium" maxLines={1}>
              {summarize(host.upstreams)}
            </Text>
          </Tooltip>
        </HStack>
      ),
    },
    ...(trafficKnown ? [] : [tlsColumn()]),
    {
      id: "agents",
      label: tNav("agents"),
      width: 170,
      render: (host) => {
        const assigned = agentAssignments?.[host.id] ?? [];
        // Empty means every agent, not none.
        if (assigned.length === 0) {
          return (
            <Text type="body" size="sm" color="secondary">
              {t("servedByEveryAgent")}
            </Text>
          );
        }
        return (
          <Text type="body" size="sm" color="secondary" maxLines={1}>
            {assigned.map((id) => agentNames.get(id) ?? `#${id}`).join(", ")}
          </Text>
        );
      },
    },
    ...(trafficKnown ? trafficColumns() : []),
    {
      id: "features",
      label: t("protections"),
      render: (host) => {
        const insight = insightFor(host);
        if (insight) return <HostProtectionBadges protections={insight.protections} />;
        const active = FEATURES.filter((f) => f.isOn(host));
        if (active.length === 0) {
          return (
            <Text type="body" size="sm" color="secondary">
              {emptyValue}
            </Text>
          );
        }
        return (
          <HStack gap={1} wrap="wrap">
            {active.map((f) => (
              <Badge key={f.key} variant={f.variant} icon={f.icon} label={t(f.labelKey)} />
            ))}
          </HStack>
        );
      },
    },
    ...(trafficKnown ? [certificateColumn()] : []),
    {
      id: "status",
      label: tCommon("status"),
      sortKey: "enabled",
      width: trafficKnown ? 160 : 110,
      render: (host) => {
        const insight = insightFor(host);
        return insight ? <HostStatusCell status={insight.status} /> : <HostStatus host={host} />;
      },
    },
    {
      id: "actions",
      label: "",
      align: "right",
      width: 120,
      render: (host) => (
        <HostActions
          host={host}
          onToggle={(enabled) => handleToggleEnabled(host.id, enabled)}
          onMaintenance={(enabled) => handleMaintenance(host.id, enabled)}
          onEdit={() => setEditHost(host)}
          onDuplicate={() => openDuplicate(host)}
          onTestReachability={() => setCheckingHost(host)}
          canCreate={canCreate}
          onDelete={() => setDeleteHost(host)}
        />
      ),
    },
  ];

  function tlsColumn(): Column<ProxyHost> {
    return {
      id: "tls",
      label: t("tls"),
      width: 180,
      render: (host) => {
        const name = host.certificateId ? certificateNames.get(host.certificateId) : undefined;
        if (!name) {
          return (
            <Text type="body" size="sm" color="secondary">
              {emptyValue}
            </Text>
          );
        }
        return (
          <Tooltip content={name}>
            <Text type="body" size="sm" maxLines={1}>
              {name}
            </Text>
          </Tooltip>
        );
      },
    };
  }

  function trafficColumns(): Column<ProxyHost>[] {
    return [
      {
        id: "requests",
        label: t("requests24h"),
        sortKey: "requests",
        align: "right",
        width: 140,
        render: (host) => {
          const insight = insightFor(host);
          return (
            <HostRequestsCell
              requests={insight?.requests ?? 0}
              blocked={insight?.blocked ?? 0}
              share={insight?.share ?? 0}
            />
          );
        },
      },
      {
        id: "serverErrors",
        label: t("detail.serverErrors"),
        align: "right",
        width: 80,
        render: (host) => {
          const insight = insightFor(host);
          return (
            <HostServerErrorsCell
              serverErrors={insight?.serverErrors ?? 0}
              requests={insight?.requests ?? 0}
            />
          );
        },
      },
    ];
  }

  function certificateColumn(): Column<ProxyHost> {
    return {
      id: "certificate",
      label: t("insights.certificate"),
      width: 110,
      render: (host) => (
        <CertificateDaysCell
          days={insightFor(host)?.certificateDaysLeft ?? null}
          name={host.certificateId ? certificateNames.get(host.certificateId) : null}
        />
      ),
    };
  }

  const mobileCard = (host: ProxyHost) => (
    <Card
      className={
        ACCENTS[!host.enabled ? "gray" : host.maintenance?.enabled ? "yellow" : "green"].edge
      }
    >
      <HStack justify="between" vAlign="start" gap={2}>
        <VStack gap={1}>
          <AstryxLink href={proxyHostDetailHref(host.id)}>
            <Text type="body" size="sm" weight="semibold">
              {host.name}
            </Text>
          </AstryxLink>
          <Text type="code" size="xsm" color="secondary" maxLines={1}>
            {summarize(host.domains)} &rarr; {host.upstreams[0]}
          </Text>
          {host.description && (
            <Text type="body" size="xsm" color="secondary" maxLines={2}>
              {host.description}
            </Text>
          )}
          <HostTagList tags={host.tags} />
          <HStack gap={2} vAlign="center">
            {insightFor(host) ? (
              <HostStatusCell status={insightFor(host)!.status} />
            ) : (
              <HostStatus host={host} />
            )}
            {host.certificateId && <Badge variant="info" label={t("tls")} />}
          </HStack>
        </VStack>
        <HostActions
          host={host}
          onToggle={(enabled) => handleToggleEnabled(host.id, enabled)}
          onMaintenance={(enabled) => handleMaintenance(host.id, enabled)}
          onEdit={() => setEditHost(host)}
          onDuplicate={() => openDuplicate(host)}
          onTestReachability={() => setCheckingHost(host)}
          canCreate={canCreate}
          onDelete={() => setDeleteHost(host)}
        />
      </HStack>
    </Card>
  );

  return (
    <VStack gap={6}>
      <ListPageHeader
        title={tNav("proxyHosts")}
        action={
          canCreate
            ? {
                label: t("createHost"),
                onClick: () => {
                  setDialogKey((k) => k + 1);
                  setCreateOpen(true);
                },
              }
            : undefined
        }
        stats={
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
                value: trafficKnown ? format.number(trafficTotals.total) : tCommon("noData"),
                note: trafficKnown
                  ? t("blockedShareNote", { percent: blockedShare })
                  : t("analyticsOffNote"),
              },
              {
                id: "certificates",
                label: tNav("certificates"),
                value: certificates.length,
                note: t("certificatesNote", { count: hostsWithTls }),
              },
              {
                id: "agents",
                label: tNav("agents"),
                value: agents?.length ?? 0,
                note: t("agentsConnectedNote", { count: connectedAgents }),
                accent:
                  (agents?.length ?? 0) > connectedAgents
                    ? { label: t("someAgentsOffline"), variant: "warning" as const }
                    : undefined,
              },
            ]}
          />
        }
        filters={
          <HStack gap={3} vAlign="center" wrap="wrap">
            <TabList value={activeState} onChange={handleStateChange}>
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
            <HostTagFilter tags={tags} value={activeTag} onChange={handleTagChange} />
          </HStack>
        }
        search={
          <SearchField
            value={searchTerm}
            onChange={handleSearchChange}
            placeholder={t("searchHosts")}
          />
        }
        bulkBar={
          selectedHosts.length > 0 && !isNarrow ? (
            <ProxyHostBulkActions
              hosts={selectedHosts}
              certificates={certificates}
              accessLists={accessLists}
              onClear={() => setSelectedKeys(new Set())}
            />
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        data={hosts}
        keyField="id"
        emptyMessage={searchTerm || activeTag ? t("noHostsMatchSearch") : t("noProxyHostsFound")}
        pagination={pagination}
        sort={initialSort}
        mobileCard={mobileCard}
        rowHref={(host) => proxyHostDetailHref(host.id)}
        rowStatus={(host) => (host.enabled ? null : { color: "gray", label: t("filterDisabled") })}
        selection={{
          selectedKeys,
          onChange: setSelectedKeys,
          isRowSelectable: (host) => manageable.has(host.id),
          rowLabel: (host) => host.name,
        }}
      />

      <CreateHostDialog
        defaultDomain={defaultDomain}
        key={dialogKey}
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setTimeout(() => setDuplicateHost(null), 200);
        }}
        initialData={duplicateHost}
        certificates={certificates}
        accessLists={accessLists}
        authentikDefaults={authentikDefaults}
        forwardAuthDefaults={forwardAuthDefaults}
        tailscaleDefaults={tailscaleDefaults}
        caCertificates={caCertificates}
        mtlsRoles={mtlsRoles ?? []}
        issuedClientCerts={issuedClientCerts ?? []}
        forwardAuthUsers={forwardAuthUsers ?? []}
        forwardAuthGroups={forwardAuthGroups ?? []}
        agents={agents ?? []}
      />

      {editHost && (
        <EditHostDialog
          open={!!editHost}
          host={editHost}
          initialSection={editSection}
          onClose={closeEditor}
          certificates={certificates}
          accessLists={accessLists}
          authentikDefaults={authentikDefaults}
          forwardAuthDefaults={forwardAuthDefaults}
          tailscaleDefaults={tailscaleDefaults}
          caCertificates={caCertificates}
          mtlsRoles={mtlsRoles ?? []}
          issuedClientCerts={issuedClientCerts ?? []}
          forwardAuthUsers={forwardAuthUsers ?? []}
          forwardAuthGroups={forwardAuthGroups ?? []}
          forwardAuthAccess={forwardAuthAccessMap?.[editHost.id] ?? null}
          agents={agents ?? []}
          assignedAgentIds={agentAssignments?.[editHost.id] ?? []}
          canEditRawConfig={canEditRawConfig}
        />
      )}

      {deleteHost && (
        <DeleteHostDialog
          open={!!deleteHost}
          host={deleteHost}
          onClose={() => setDeleteHost(null)}
        />
      )}

      {checkingHost && (
        <ReachabilityDialog
          open
          hostId={checkingHost.id}
          hostName={checkingHost.name}
          onClose={() => setCheckingHost(null)}
        />
      )}
    </VStack>
  );
}
