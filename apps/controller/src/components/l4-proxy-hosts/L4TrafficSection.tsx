"use client";

/** An L4 host's last day of connections on its overview, or why there are none to show. */

import { BarChart2, Users } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/Stack";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { FlagIcon } from "@/src/components/ui/CountryFlag";
import { StatTiles } from "@/components/ui/StatTiles";
import { useTableDensity } from "@/components/ui/TableDensity";
import { SectionCard } from "@/components/proxy-hosts/detail/SectionCard";
import { formatBytes } from "@/src/app/(dashboard)/analytics/explore/format";
import { settingsHref } from "@/src/app/(dashboard)/settings/sections";
import type { L4ClientRow } from "@/lib/clickhouse/l4-traffic";
import type { L4HostTraffic } from "@/lib/l4/detail-types";
import { L4ConnectionsChart } from "./L4ConnectionsChart";

/** A connection may last a second or a day, so the unit follows the length. */
function durationUnit(ms: number): {
  value: number;
  unit: "millisecond" | "second" | "minute" | "hour";
} {
  if (ms < 1000) return { value: ms, unit: "millisecond" };
  if (ms < 60_000) return { value: ms / 1000, unit: "second" };
  if (ms < 3_600_000) return { value: ms / 60_000, unit: "minute" };
  return { value: ms / 3_600_000, unit: "hour" };
}

export function L4TrafficSection({ traffic }: { traffic: L4HostTraffic }) {
  const t = useTranslations("l4ProxyHosts.detail");
  const tDetail = useTranslations("proxyHosts.detail");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const format = useAppFormatter();
  const density = useTableDensity();

  if (traffic.state === "off") {
    return (
      <Card padding={5}>
        <EmptyState
          // Straight under the page's h1: no section card wraps it, unlike the ones below.
          headingLevel={2}
          title={t("offTitle")}
          description={t("offDescription")}
          actions={
            <Button variant="secondary" label={tNav("settings")} href={settingsHref("logging")} />
          }
          isCompact
        />
      </Card>
    );
  }

  const { report, sharedWith } = traffic;
  const { totals } = report;
  const average = totals.avgDurationMs === null ? null : durationUnit(totals.avgDurationMs);
  const averageDuration =
    average &&
    format.number(average.value, {
      style: "unit",
      unit: average.unit,
      unitDisplay: "short",
      maximumFractionDigits: 1,
    });
  const columns: TableColumn<L4ClientRow & { id: string }>[] = [
    {
      key: "ip",
      header: tCommon("clientIp"),
      width: proportional(3),
      renderCell: (row) => (
        <HStack gap={2} vAlign="center">
          {row.country && <FlagIcon code={row.country} />}
          <Text type="code" size="sm" maxLines={1}>
            {row.ip}
          </Text>
        </HStack>
      ),
    },
    {
      key: "connections",
      header: t("chartConnections"),
      width: pixel(120),
      align: "end",
      renderCell: (row) => (
        <Text type="code" size="sm">
          {format.number(row.connections)}
        </Text>
      ),
    },
    {
      key: "bytes",
      header: t("clientsTraffic"),
      width: pixel(110),
      align: "end",
      renderCell: (row) => (
        <Text type="code" size="sm">
          {formatBytes(format, row.bytes)}
        </Text>
      ),
    },
  ];

  return (
    <>
      {sharedWith > 0 && <Banner status="info" title={t("sharedPort", { count: sharedWith })} />}
      <StatTiles
        tiles={[
          {
            id: "connections",
            label: t("tileConnections"),
            value: format.number(totals.connections),
            note: averageDuration && t("avgDuration", { duration: averageDuration }),
          },
          {
            id: "clients",
            label: tDetail("tileClients"),
            value: format.number(totals.uniqueIps),
          },
          {
            id: "received",
            label: t("tileReceived"),
            value: formatBytes(format, totals.bytesIn),
          },
          {
            id: "sent",
            label: t("tileSentToClients"),
            value: formatBytes(format, totals.bytesOut),
          },
        ]}
      />
      <Grid columns={{ minWidth: 360, max: 2 }} gap={4}>
        <SectionCard icon={BarChart2} title={t("chartTitle")}>
          <L4ConnectionsChart timeline={report.timeline} />
        </SectionCard>
        <SectionCard icon={Users} title={t("clientsTitle")}>
          {report.clients.length === 0 ? (
            <EmptyState title={t("chartEmpty")} isCompact />
          ) : (
            <Table
              data={report.clients.map((row) => ({ ...row, id: row.ip }))}
              columns={columns}
              idKey="id"
              density={density}
            />
          )}
        </SectionCard>
      </Grid>
    </>
  );
}
