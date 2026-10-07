"use client";

import type { EditorRollback } from "@/components/host-history/RollbackNotice";
import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Network, ArrowRight, Shield } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { ACCENTS } from "@/components/ui/accent";
import { Icon } from "@astryxdesign/core/Icon";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Switch } from "@astryxdesign/core/Switch";
import { HostNotesHint } from "@/components/proxy-hosts/HostNotesField";
import { HostTagFilter, HostTagList } from "@/components/proxy-hosts/HostTagsField";
import { duplicateL4ProxyHostDraft } from "@/src/lib/proxy-hosts/duplicate";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Text } from "@astryxdesign/core/Text";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import type { L4AccessListOption } from "@/src/lib/models/access-lists";
import { toggleL4ProxyHostAction } from "./actions";
import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { SearchField } from "@/components/ui/SearchField";
import { StatTiles } from "@/components/ui/StatTiles";
import { DataTable, type Column, useRowSelection } from "@/components/ui/DataTable";
import { L4HostBulkActions } from "@/components/l4-proxy-hosts/L4HostBulkActions";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  CreateL4HostDialog,
  EditL4HostDialog,
  DeleteL4HostDialog,
} from "@/components/l4-proxy-hosts/L4HostDialogs";
import { L4PortsApplyBanner } from "@/components/l4-proxy-hosts/L4PortsApplyBanner";
import { useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { Banner } from "@astryxdesign/core/Banner";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import type { AgentOption } from "@/components/agents/AgentAssignmentFields";
import { useTranslations } from "next-intl";
import { clearEditorLink } from "@/components/host-review/section-link";
import {
  type L4EditorSection,
  isL4EditorSection,
  l4ProxyHostHistoryHref,
} from "@/src/lib/l4/editor-sections";

type Props = {
  hosts: L4ProxyHost[];
  pagination: { total: number; page: number; perPage: number };
  /** Protocol and enabled totals across everything visible, so tabs do not count only this page. */
  counts: { total: number; tcp: number; udp: number; enabled: number };
  activeProtocol: "all" | "tcp" | "udp";
  initialSearch: string;
  /** Every tag on a host the viewer can see, for the filter. */
  tags?: string[];
  activeTag?: string | null;
  initialSort?: { sortBy: string; sortDir: "asc" | "desc" };
  agents?: AgentOption[];
  accessLists?: L4AccessListOption[];
  /** A host absent from here is served by every agent. */
  agentAssignments?: Record<number, number[]>;
  /** False for an operator - see ProxyHostsClient. */
  canCreate?: boolean;
  /** This page's hosts the viewer may change; the rest get a disabled checkbox. */
  manageableIds?: number[];
  /** A host to open the editor on, from an `?edit=` link. */
  editTarget?: L4ProxyHost | null;
  /** Set when `editTarget` is a revision loaded for a rollback rather than the stored host. */
  rollback?: EditorRollback | null;
};

function formatMatcher(
  host: L4ProxyHost,
  t: ReturnType<typeof useTranslations<"l4ProxyHosts">>,
): string {
  switch (host.matcherType) {
    case "tls_sni":
      return t("matcherSummarySni", { hostnames: host.matcherValue.join(", ") });
    case "http_host":
      return t("matcherSummaryHost", { hostnames: host.matcherValue.join(", ") });
    case "proxy_protocol":
      return t("optMatcherProxyProtocol");
    default:
      return t("optProxyProtocolNone");
  }
}

function ProtocolBadge({ protocol }: { protocol: string }) {
  return <Badge variant={protocol === "tcp" ? "info" : "warning"} label={protocol.toUpperCase()} />;
}

/** Restricting traffic, like the proxy hosts' auth badge: named in the tooltip. */
function AccessListBadge({
  host,
  accessLists,
}: {
  host: L4ProxyHost;
  accessLists: L4AccessListOption[];
}) {
  const t = useTranslations("l4ProxyHosts");
  if (host.accessListId === null) return null;
  const name = accessLists.find((list) => list.id === host.accessListId)?.name;
  return (
    <Tooltip content={name ? t("ipRulesBadgeTooltip", { name }) : t("ipRulesBadge")}>
      <Badge variant="warning" icon={<Shield />} label={t("ipRulesBadge")} />
    </Tooltip>
  );
}

function summarizeUpstreams(upstreams: string[]) {
  return upstreams.length > 1 ? `${upstreams[0]} +${upstreams.length - 1}` : upstreams[0];
}

/** Null for a single port. A regex, not caddy-utils: that module pulls in node:net. */
function listenPortCount(listenAddress: string): number | null {
  const match = /:(\d+)-(\d+)$/.exec(listenAddress.trim());
  return match ? Number(match[2]) - Number(match[1]) + 1 : null;
}

/**
 * The enable switch plus the row menu, shared by table and cards. At module scope - nesting it
 * would make a new component type each render, remounting the menu mid-use.
 */
function HostActions({
  host,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
  canCreate,
}: {
  host: L4ProxyHost;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Duplicating makes a new host, so it follows Create, not Edit. */
  canCreate: boolean;
}) {
  const tCommon = useTranslations("common");
  const tProxyHosts = useTranslations("proxyHosts");
  const tSettings = useTranslations("settings");
  const router = useRouter();
  return (
    <HStack gap={2} vAlign="center" justify="end">
      <Switch
        label={tProxyHosts("enableHostLabel", { name: host.name })}
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
          {
            label: tSettings("history.navLabel"),
            onClick: () => router.push(l4ProxyHostHistoryHref(host.id)),
          },
          { type: "divider" },
          { label: tCommon("delete"), variant: "destructive", onClick: onDelete },
        ]}
      />
    </HStack>
  );
}

export default function L4ProxyHostsClient({
  hosts,
  pagination,
  counts,
  activeProtocol,
  initialSearch,
  tags = [],
  activeTag = null,
  initialSort,
  agents,
  accessLists = [],
  agentAssignments,
  canCreate = true,
  manageableIds = [],
  editTarget = null,
  rollback = null,
}: Props) {
  const t = useTranslations("l4ProxyHosts");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const tProxyHosts = useTranslations("proxyHosts");
  const [createOpen, setCreateOpen] = useState(false);
  const [duplicateHost, setDuplicateHost] = useState<L4ProxyHost | null>(null);
  const [editHost, setEditHost] = useState<L4ProxyHost | null>(editTarget);
  const [editSection, setEditSection] = useState<L4EditorSection | null>(null);
  const [deleteHost, setDeleteHost] = useState<L4ProxyHost | null>(null);
  // Bumped on every open so CreateL4HostDialog remounts and its useActionState starts clean -
  // otherwise the previous save's "success" state closes the freshly reopened dialog (#241).
  const [dialogKey, setDialogKey] = useState(0);
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [bannerRefresh, setBannerRefresh] = useState(0);
  const l4DisabledReason = useDisabledReason("l4");

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const signalBannerRefresh = () => setBannerRefresh((n) => n + 1);
  const [selectedKeys, setSelectedKeys] = useRowSelection(hosts, "id");
  const manageable = new Set(manageableIds);
  const selectedHosts = hosts.filter((host) => selectedKeys.has(String(host.id)));
  // Hidden on a phone in v1: the cards have no checkboxes to select with.
  const isNarrow = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    setSearchTerm(initialSearch);
  }, [initialSearch]);

  // The section rides in the hash, which the server never sees.
  useEffect(() => {
    if (!editTarget) return;
    const hash = window.location.hash.slice(1);
    setEditSection(isL4EditorSection(hash) ? hash : null);
    setEditHost(editTarget);
  }, [editTarget]);

  function closeEditor() {
    setEditHost(null);
    setEditSection(null);
    if (searchParams.has("edit")) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("edit");
      params.delete("revision");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
      return;
    }
    clearEditorLink();
    // revalidatePath alone leaves this client tree on its old props (#241).
    router.refresh();
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

  function handleProtocolChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") params.delete("protocol");
    else params.set("protocol", value);
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`);
  }

  const handleToggleEnabled = async (id: number, enabled: boolean) => {
    await toggleL4ProxyHostAction(id, enabled);
    signalBannerRefresh();
    // revalidatePath alone leaves this client tree on its old props (#241).
    router.refresh();
  };

  function openCreate() {
    setDialogKey((k) => k + 1);
    setCreateOpen(true);
  }

  function openDuplicate(host: L4ProxyHost) {
    setDuplicateHost(duplicateL4ProxyHostDraft(host));
    openCreate();
  }

  const actionsFor = (host: L4ProxyHost) => (
    <HostActions
      host={host}
      onToggle={(enabled) => handleToggleEnabled(host.id, enabled)}
      onEdit={() => setEditHost(host)}
      onDuplicate={() => openDuplicate(host)}
      onDelete={() => setDeleteHost(host)}
      canCreate={canCreate}
    />
  );

  const columns: Column<L4ProxyHost>[] = [
    {
      id: "name",
      label: t("columnNameMatcher"),
      sortKey: "name",
      render: (host) => (
        <HStack gap={3} vAlign="center">
          <Icon icon={Network} size="sm" color={host.protocol === "tcp" ? "accent" : "warning"} />
          <VStack gap={0} className="cpm-cell-lines">
            <HStack gap={1} vAlign="center">
              <Text type="body" size="sm" weight="semibold">
                {host.name}
              </Text>
              <HostNotesHint notes={host.description} />
              <AccessListBadge host={host} accessLists={accessLists} />
            </HStack>
            <Tooltip content={formatMatcher(host, t)}>
              <Text type="body" size="sm" color="secondary" maxLines={1}>
                {formatMatcher(host, t)}
              </Text>
            </Tooltip>
            <HostTagList tags={host.tags} />
          </VStack>
        </HStack>
      ),
    },
    {
      id: "protocol",
      label: tProxyHosts("protocol"),
      sortKey: "protocol",
      width: 90,
      render: (host) => <ProtocolBadge protocol={host.protocol} />,
    },
    {
      id: "listen",
      label: t("listen"),
      sortKey: "listenAddress",
      render: (host) => {
        const count = listenPortCount(host.listenAddress);
        return (
          <VStack gap={0}>
            <Text type="code" size="sm" weight="medium" hasTabularNumbers>
              {host.listenAddress}
            </Text>
            {count !== null && (
              <Text type="body" size="sm" color="secondary">
                {t("listenPortCount", { count })}
              </Text>
            )}
          </VStack>
        );
      },
    },
    {
      id: "upstreams",
      label: tProxyHosts("upstreams"),
      render: (host) => (
        <HStack gap={2} vAlign="center">
          <Icon icon={ArrowRight} size="xsm" color="secondary" />
          <Tooltip content={host.upstreams.join(", ")}>
            <Text type="code" size="sm" weight="medium" maxLines={1}>
              {host.upstreamPortMode === "same"
                ? t("upstreamOnListenPort", { upstream: summarizeUpstreams(host.upstreams) })
                : summarizeUpstreams(host.upstreams)}
            </Text>
          </Tooltip>
        </HStack>
      ),
    },
    {
      id: "status",
      label: tCommon("status"),
      sortKey: "enabled",
      width: 110,
      render: (host) => <StatusChip status={host.enabled ? "active" : "inactive"} />,
    },
    {
      id: "actions",
      label: "",
      align: "right",
      width: 120,
      render: (host) => actionsFor(host),
    },
  ];

  const mobileCard = (host: L4ProxyHost) => (
    <Card className={ACCENTS[host.enabled ? "green" : "gray"].edge}>
      <HStack justify="between" vAlign="start" gap={2}>
        <StackItem size="fill">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <Text type="body" size="sm" weight="semibold">
                {host.name}
              </Text>
              <ProtocolBadge protocol={host.protocol} />
              <AccessListBadge host={host} accessLists={accessLists} />
            </HStack>
            <Text type="code" size="sm" color="secondary" maxLines={1}>
              {host.listenAddress} &rarr; {summarizeUpstreams(host.upstreams)}
            </Text>
            {host.description && (
              <Text type="body" size="sm" color="secondary" maxLines={2}>
                {host.description}
              </Text>
            )}
            <HostTagList tags={host.tags} />
            <StatusChip status={host.enabled ? "active" : "inactive"} />
          </VStack>
        </StackItem>
        {actionsFor(host)}
      </HStack>
    </Card>
  );

  return (
    <VStack gap={6}>
      {/* Hosts stay listed while the module is off: hiding them would make them look deleted. */}
      {l4DisabledReason && (
        <Banner
          status="warning"
          title={t("l4DisabledTitle")}
          description={t("l4DisabledDescription", { reason: l4DisabledReason })}
        />
      )}

      {!l4DisabledReason && <L4PortsApplyBanner refreshSignal={bannerRefresh} />}

      <ListPageHeader
        title={tNav("l4ProxyHosts")}
        action={
          canCreate
            ? {
                label: tCommon("new"),
                onClick: openCreate,
                isDisabled: Boolean(l4DisabledReason),
              }
            : undefined
        }
        stats={
          <StatTiles
            tiles={[
              {
                id: "hosts",
                label: tNav("l4ProxyHosts"),
                value: counts.total,
                note: t("enabledNote", { count: counts.enabled }),
              },
              { id: "tcp", label: t("tcpStreams"), value: counts.tcp, note: t("tcpNote") },
              { id: "udp", label: t("udpStreams"), value: counts.udp, note: t("udpNote") },
              {
                id: "agents",
                label: tNav("agents"),
                value: agents?.length ?? 0,
                note: t("listenersNote"),
              },
            ]}
          />
        }
        filters={
          <HStack gap={3} vAlign="center" wrap="wrap">
            <TabList value={activeProtocol} onChange={handleProtocolChange}>
              <Tab value="all" label={t("filterAll")} endContent={<Badge label={counts.total} />} />
              <Tab value="tcp" label="TCP" endContent={<Badge label={counts.tcp} />} />
              <Tab value="udp" label="UDP" endContent={<Badge label={counts.udp} />} />
            </TabList>
            <HostTagFilter tags={tags} value={activeTag} onChange={handleTagChange} />
          </HStack>
        }
        search={
          <SearchField
            value={searchTerm}
            onChange={handleSearchChange}
            placeholder={t("searchL4Hosts")}
          />
        }
        bulkBar={
          selectedHosts.length > 0 && !isNarrow ? (
            <L4HostBulkActions
              hosts={selectedHosts}
              onClear={() => setSelectedKeys(new Set())}
              onDone={() => {
                signalBannerRefresh();
                router.refresh();
              }}
            />
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        data={hosts}
        keyField="id"
        emptyMessage={searchTerm || activeTag ? t("searchEmptyMessage") : t("emptyMessage")}
        pagination={pagination}
        sort={initialSort}
        mobileCard={mobileCard}
        rowStatus={(host) => (host.enabled ? null : { color: "gray", label: t("disabled") })}
        selection={{
          selectedKeys,
          onChange: setSelectedKeys,
          isRowSelectable: (host) => manageable.has(host.id),
          rowLabel: (host) => host.name,
        }}
      />

      <CreateL4HostDialog
        key={dialogKey}
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setTimeout(() => setDuplicateHost(null), 200);
          signalBannerRefresh();
          router.refresh();
        }}
        initialData={duplicateHost}
        agents={agents ?? []}
        accessLists={accessLists}
      />

      {editHost && (
        <EditL4HostDialog
          open={!!editHost}
          host={editHost}
          rollback={rollback && editHost === editTarget ? rollback : null}
          initialSection={editSection}
          onClose={() => {
            signalBannerRefresh();
            closeEditor();
          }}
          agents={agents ?? []}
          accessLists={accessLists}
          assignedAgentIds={agentAssignments?.[editHost.id] ?? []}
        />
      )}

      {deleteHost && (
        <DeleteL4HostDialog
          open={!!deleteHost}
          host={deleteHost}
          onClose={() => {
            setDeleteHost(null);
            signalBannerRefresh();
            router.refresh();
          }}
        />
      )}
    </VStack>
  );
}
