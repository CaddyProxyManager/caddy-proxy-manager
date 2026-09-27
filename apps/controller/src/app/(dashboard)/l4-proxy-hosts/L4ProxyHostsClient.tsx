"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Network, ArrowRight } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Switch } from "@astryxdesign/core/Switch";
import { HostNotesHint } from "@/components/proxy-hosts/HostNotesField";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { toggleL4ProxyHostAction } from "./actions";
import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { SearchField } from "@/components/ui/SearchField";
import { StatTiles } from "@/components/ui/StatTiles";
import { DataTable, type Column } from "@/components/ui/DataTable";
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

type Props = {
  hosts: L4ProxyHost[];
  pagination: { total: number; page: number; perPage: number };
  /** Protocol and enabled totals across everything visible, so tabs do not count only this page. */
  counts: { total: number; tcp: number; udp: number; enabled: number };
  activeProtocol: "all" | "tcp" | "udp";
  initialSearch: string;
  initialSort?: { sortBy: string; sortDir: "asc" | "desc" };
  agents?: AgentOption[];
  /** A host absent from here is served by every agent. */
  agentAssignments?: Record<number, number[]>;
  /** False for an operator - see ProxyHostsClient. */
  canCreate?: boolean;
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

function summarizeUpstreams(upstreams: string[]) {
  return upstreams.length > 1 ? `${upstreams[0]} +${upstreams.length - 1}` : upstreams[0];
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
  const t = useTranslations("l4ProxyHosts");
  return (
    <HStack gap={2} vAlign="center" justify="end">
      <Switch
        label={t("enableHostNamed", { name: host.name })}
        isLabelHidden
        value={host.enabled}
        onChange={onToggle}
      />
      <MoreMenu
        label={t("actionsForHost", { name: host.name })}
        size="sm"
        alignment="end"
        items={[
          { label: t("edit"), onClick: onEdit },
          ...(canCreate ? [{ label: t("duplicate"), onClick: onDuplicate }] : []),
          { type: "divider" },
          { label: t("delete"), variant: "destructive", onClick: onDelete },
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
  initialSort,
  agents,
  agentAssignments,
  canCreate = true,
}: Props) {
  const t = useTranslations("l4ProxyHosts");
  const [createOpen, setCreateOpen] = useState(false);
  const [duplicateHost, setDuplicateHost] = useState<L4ProxyHost | null>(null);
  const [editHost, setEditHost] = useState<L4ProxyHost | null>(null);
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

  useEffect(() => {
    setSearchTerm(initialSearch);
  }, [initialSearch]);

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
    setDuplicateHost(host);
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
            </HStack>
            <Tooltip content={formatMatcher(host, t)}>
              <Text type="body" size="xsm" color="secondary" maxLines={1}>
                {formatMatcher(host, t)}
              </Text>
            </Tooltip>
          </VStack>
        </HStack>
      ),
    },
    {
      id: "protocol",
      label: t("protocol"),
      sortKey: "protocol",
      width: 90,
      render: (host) => <ProtocolBadge protocol={host.protocol} />,
    },
    {
      id: "listen",
      label: t("listen"),
      sortKey: "listenAddress",
      render: (host) => (
        <Text type="code" size="sm" weight="medium" hasTabularNumbers>
          {host.listenAddress}
        </Text>
      ),
    },
    {
      id: "upstreams",
      label: t("upstreams"),
      render: (host) => (
        <HStack gap={2} vAlign="center">
          <Icon icon={ArrowRight} size="xsm" color="secondary" />
          <Tooltip content={host.upstreams.join(", ")}>
            <Text type="code" size="sm" weight="medium" maxLines={1}>
              {summarizeUpstreams(host.upstreams)}
            </Text>
          </Tooltip>
        </HStack>
      ),
    },
    {
      id: "status",
      label: t("status"),
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
    <Card>
      <HStack justify="between" vAlign="start" gap={2}>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Text type="body" size="sm" weight="semibold">
              {host.name}
            </Text>
            <ProtocolBadge protocol={host.protocol} />
          </HStack>
          <Text type="code" size="xsm" color="secondary" maxLines={1}>
            {host.listenAddress} &rarr; {summarizeUpstreams(host.upstreams)}
          </Text>
          {host.description && (
            <Text type="body" size="xsm" color="secondary" maxLines={2}>
              {host.description}
            </Text>
          )}
          <StatusChip status={host.enabled ? "active" : "inactive"} />
        </VStack>
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
        title={t("l4ProxyHosts")}
        action={
          canCreate
            ? {
                label: t("createL4Host"),
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
                label: t("l4ProxyHosts"),
                value: counts.total,
                note: t("enabledNote", { count: counts.enabled }),
              },
              { id: "tcp", label: t("tcpStreams"), value: counts.tcp, note: t("tcpNote") },
              { id: "udp", label: t("udpStreams"), value: counts.udp, note: t("udpNote") },
              {
                id: "agents",
                label: t("listeners"),
                value: agents?.length ?? 0,
                note: t("listenersNote"),
              },
            ]}
          />
        }
        filters={
          <TabList value={activeProtocol} onChange={handleProtocolChange}>
            <Tab value="all" label={t("filterAll")} endContent={<Badge label={counts.total} />} />
            <Tab value="tcp" label="TCP" endContent={<Badge label={counts.tcp} />} />
            <Tab value="udp" label="UDP" endContent={<Badge label={counts.udp} />} />
          </TabList>
        }
        search={
          <SearchField
            value={searchTerm}
            onChange={handleSearchChange}
            placeholder={t("searchL4Hosts")}
          />
        }
      />

      <DataTable
        columns={columns}
        data={hosts}
        keyField="id"
        emptyMessage={searchTerm ? t("searchEmptyMessage") : t("emptyMessage")}
        pagination={pagination}
        sort={initialSort}
        mobileCard={mobileCard}
        rowStatus={(host) => (host.enabled ? null : { color: "gray", label: t("disabled") })}
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
      />

      {editHost && (
        <EditL4HostDialog
          open={!!editHost}
          host={editHost}
          onClose={() => {
            setEditHost(null);
            signalBannerRefresh();
            router.refresh();
          }}
          agents={agents ?? []}
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
