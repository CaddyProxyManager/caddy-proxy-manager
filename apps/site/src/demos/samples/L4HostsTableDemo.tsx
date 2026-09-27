import { Badge } from "@astryxdesign/core/Badge";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { HostNotesHint } from "@cpm/controller/src/components/proxy-hosts/HostNotesField";
import { DataTable, type Column } from "@cpm/controller/src/components/ui/DataTable";
import { StatTiles } from "@cpm/controller/src/components/ui/StatTiles";
import { StatusChip } from "@cpm/controller/src/components/ui/StatusChip";
import { useRouter, useSearchParams } from "../shims/next-navigation";
import { DemoSurface } from "../DemoSurface";

type Row = {
  id: number;
  name: string;
  listen: string;
  matcher: string;
  upstream: string;
  notes: string | null;
  status: "active" | "inactive" | "warning";
};

/** One of each thing the page can show: a plain port, an SNI split, and a port pending a recreate. */
const HOSTS: Row[] = [
  {
    id: 1,
    name: "postgres",
    listen: "5432/tcp",
    matcher: "-",
    upstream: "db:5432",
    notes: "Primary and replica. Failover is manual; see the runbook.",
    status: "active",
  },
  {
    id: 2,
    name: "minecraft",
    listen: "25565/tcp",
    matcher: "-",
    upstream: "mc:25565",
    notes: null,
    status: "active",
  },
  {
    id: 3,
    name: "mqtt",
    listen: "8883/tcp",
    matcher: "SNI mqtt.example.com",
    upstream: "mosquitto:8883",
    notes: null,
    status: "active",
  },
  {
    id: 4,
    name: "wireguard",
    listen: "51820/udp",
    matcher: "-",
    upstream: "wg:51820",
    notes: null,
    status: "warning",
  },
];

const protocolOf = (row: Row) => (row.listen.endsWith("/udp") ? "udp" : "tcp");

/** The app's tabs filter the query; here the rows are filtered off the same `protocol` param. */
function L4HostsTableDemoContent() {
  const t = useTranslations("l4ProxyHosts");
  const router = useRouter();
  const params = useSearchParams();
  const protocol =
    params.get("protocol") === "tcp" || params.get("protocol") === "udp"
      ? (params.get("protocol") as "tcp" | "udp")
      : "all";
  const tcp = HOSTS.filter((h) => protocolOf(h) === "tcp").length;
  const udp = HOSTS.length - tcp;
  const rows = protocol === "all" ? HOSTS : HOSTS.filter((h) => protocolOf(h) === protocol);

  function setProtocol(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("protocol");
    else next.set("protocol", value);
    router.push(`${location.pathname}?${next.toString()}`);
  }

  const columns: Column<Row>[] = [
    {
      id: "name",
      label: "Name",
      render: (r) => (
        <HStack gap={1} vAlign="center">
          <Text type="body" size="sm" weight="semibold">
            {r.name}
          </Text>
          <HostNotesHint notes={r.notes} />
        </HStack>
      ),
    },
    { id: "listen", label: "Listening", render: (r) => <Badge label={r.listen} /> },
    {
      id: "matcher",
      label: "Matcher",
      render: (r) => (
        <Text type="body" size="sm" color="secondary">
          {r.matcher}
        </Text>
      ),
    },
    {
      id: "upstream",
      label: "Upstream",
      render: (r) => (
        <Text type="body" size="sm" color="secondary">
          {r.upstream}
        </Text>
      ),
    },
    {
      id: "status",
      label: "Status",
      render: (r) => (
        <StatusChip status={r.status} label={r.status === "warning" ? "Port pending" : undefined} />
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
              label: t("l4ProxyHosts"),
              value: HOSTS.length,
              note: t("enabledNote", { count: HOSTS.length }),
            },
            { id: "tcp", label: t("tcpStreams"), value: tcp, note: t("tcpNote") },
            { id: "udp", label: t("udpStreams"), value: udp, note: t("udpNote") },
            { id: "agents", label: t("listeners"), value: 2, note: t("listenersNote") },
          ]}
        />
      </div>
      <TabList value={protocol} onChange={setProtocol}>
        <Tab value="all" label={t("filterAll")} endContent={<Badge label={HOSTS.length} />} />
        <Tab value="tcp" label="TCP" endContent={<Badge label={tcp} />} />
        <Tab value="udp" label="UDP" endContent={<Badge label={udp} />} />
      </TabList>
      <DataTable columns={columns} data={rows} keyField="id" emptyMessage="No L4 hosts yet" />
    </VStack>
  );
}

/** Inside DemoSurface, which provides the catalog useTranslations reads. */
export default function L4HostsTableDemo() {
  return (
    <DemoSurface>
      <L4HostsTableDemoContent />
    </DemoSurface>
  );
}
