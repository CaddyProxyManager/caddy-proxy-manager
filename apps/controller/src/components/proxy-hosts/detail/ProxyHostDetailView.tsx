"use client";

/**
 * A proxy host's page: what needs attention, its last day of traffic, its upstreams' live health,
 * a line per editor section linking into the editor, and its recent changes. Presentational, so
 * the docs can render it with sample data; the route gathers everything in lib/proxy-hosts/detail.
 */

import {
  ArrowLeft,
  BarChart2,
  History,
  ListChecks,
  Pencil,
  Server,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { AttentionList } from "@/components/attention/AttentionList";
import { hasAttentionToShow } from "@/lib/attention/types";
import { HostTagList } from "@/components/proxy-hosts/HostTagsField";
import {
  CertificateDaysCell,
  HostProtectionBadges,
  HostStatusCell,
} from "@/components/proxy-hosts/HostInsightCells";
import { UpstreamHealthPanel } from "@/components/proxy-hosts/upstreams/UpstreamHealthPanel";
import { StatTiles } from "@/components/ui/StatTiles";
import { Timestamp } from "@/components/ui/Timestamp";
import { useTableDensity } from "@/components/ui/TableDensity";
import { formatBytes, formatShare } from "@/src/app/(dashboard)/analytics/explore/format";
import { editorSectionHref, proxyHostDetailHref } from "@/lib/proxy-hosts/editor-sections";
import { HostPageTabs } from "@/components/host-history/HostPageTabs";
import type { ProxyHostDetail } from "@/lib/proxy-hosts/detail-types";
import type { HostPathRow, HostStatusRow } from "@/lib/clickhouse/host-traffic";
import type { SectionFact } from "@/lib/proxy-hosts/section-summary";
import { HostTrafficChart } from "./HostTrafficChart";

export type HostAuditRow = {
  id: number;
  action: string;
  /** Translated on the server, as the audit log page does. */
  summary: string;
  actor: string | null;
  createdAt: string;
};

type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

function SectionCard({
  icon,
  title,
  action,
  children,
}: {
  icon: typeof Server;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card padding={5}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2}>
          <HStack gap={2} vAlign="center">
            <Icon icon={icon} size="sm" color="accent" />
            <Heading level={2} accessibilityLevel={2}>
              {title}
            </Heading>
          </HStack>
          {action}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}

export function ProxyHostDetailView({
  detail,
  auditRows,
  canManage,
  analyticsHref,
  logsHref,
  historyHref = null,
}: {
  detail: Omit<ProxyHostDetail, "audit">;
  auditRows: HostAuditRow[] | null;
  canManage: boolean;
  /** Administrators with analytics on. */
  analyticsHref: string | null;
  /** Administrators only: access logs carry every client's address. */
  logsHref: string | null;
  /** Those who may manage the host; its revisions name who changed it. */
  historyHref?: string | null;
}) {
  const t = useTranslations("proxyHosts.detail");
  const tOverview = useTranslations("overview");
  const tAttention = useTranslations("attention");
  const tNav = useTranslations("nav");
  const tAuditLog = useTranslations("auditLog");
  const tCommon = useTranslations("common");
  const tProxyHosts = useTranslations("proxyHosts");
  const tFacts = useTranslations("proxyHosts.detail.facts") as unknown as DynamicTranslate;
  const format = useAppFormatter();
  const density = useTableDensity();
  const { host, traffic } = detail;

  const factText = (facts: SectionFact[]) =>
    facts.map((fact) => tFacts(fact.code, fact.values)).join(" · ");

  const pathColumns: TableColumn<HostPathRow & { id: string }>[] = [
    {
      key: "path",
      header: tProxyHosts("path"),
      width: proportional(3),
      renderCell: (row) => (
        <Text type="code" size="sm" maxLines={1}>
          {row.path || "/"}
        </Text>
      ),
    },
    {
      key: "requests",
      header: tCommon("requests"),
      width: pixel(110),
      align: "end",
      renderCell: (row) => (
        <Text type="code" size="sm">
          {format.number(row.requests)}
        </Text>
      ),
    },
    {
      key: "serverErrors",
      header: t("serverErrors"),
      width: pixel(90),
      align: "end",
      renderCell: (row) => (
        <Text type="code" size="sm" color={row.serverErrors > 0 ? undefined : "secondary"}>
          {format.number(row.serverErrors)}
        </Text>
      ),
    },
  ];

  const statusColumns: TableColumn<HostStatusRow & { id: string }>[] = [
    {
      key: "status",
      header: t("status"),
      width: proportional(1),
      renderCell: (row) => (
        <Badge
          variant={row.status >= 500 ? "error" : row.status >= 400 ? "warning" : "success"}
          label={String(row.status)}
        />
      ),
    },
    {
      key: "requests",
      header: tCommon("requests"),
      width: pixel(110),
      align: "end",
      renderCell: (row) => (
        <Text type="code" size="sm">
          {format.number(row.requests)}
        </Text>
      ),
    },
  ];

  const auditColumns: TableColumn<HostAuditRow>[] = [
    {
      key: "createdAt",
      header: t("auditTime"),
      width: pixel(180),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          <Timestamp value={row.createdAt} />
        </Text>
      ),
    },
    {
      key: "summary",
      header: t("auditChange"),
      width: proportional(3),
      renderCell: (row) => (
        <VStack gap={0} className="cpm-cell-lines">
          <Text type="body" size="sm" maxLines={1}>
            {row.summary}
          </Text>
          <Text type="body" size="sm" color="secondary">
            {row.actor ?? tAuditLog("systemActor")}
          </Text>
        </VStack>
      ),
    },
  ];

  return (
    <VStack gap={5}>
      <VStack gap={2}>
        <HStack>
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft />}
            label={tNav("proxyHosts")}
            href="/proxy-hosts"
          />
        </HStack>
        <HStack justify="between" vAlign="center" gap={4} wrap="wrap">
          <VStack gap={1}>
            <HStack gap={3} vAlign="center" wrap="wrap">
              <Heading level={1}>{host.name}</Heading>
              <HostStatusCell status={detail.status} />
            </HStack>
            <Text type="code" size="sm" color="secondary">
              {host.domains.join(", ")}
            </Text>
            <HostTagList tags={host.tags} />
          </VStack>
          <HStack gap={2} wrap="wrap">
            {analyticsHref && (
              <Button variant="secondary" label={tNav("analytics")} href={analyticsHref} />
            )}
            {logsHref && <Button variant="secondary" label={tNav("logs")} href={logsHref} />}
            {canManage && (
              <Button
                variant="primary"
                icon={<Pencil />}
                label={tCommon("edit")}
                href={editorSectionHref(host.uuid)}
              />
            )}
          </HStack>
        </HStack>
        {historyHref && (
          <HostPageTabs
            active="overview"
            overviewHref={proxyHostDetailHref(host.uuid)}
            historyHref={historyHref}
          />
        )}
      </VStack>

      {hasAttentionToShow(detail.attention) && (
        <SectionCard icon={TriangleAlert} title={tAttention("title")}>
          <AttentionList list={detail.attention} emptyTitle={t("attentionEmpty")} />
        </SectionCard>
      )}

      {traffic ? (
        <>
          <StatTiles
            tiles={[
              {
                id: "requests",
                label: t("tileRequests"),
                value: format.number(traffic.totals.requests),
                note: t("tileMitigated", { count: format.number(traffic.totals.mitigated) }),
              },
              {
                id: "serverErrors",
                label: tOverview("metricServerErrors"),
                value: format.number(traffic.totals.serverErrors),
                note: tCommon("shareOfRequests", {
                  share: formatShare(format, traffic.totals.serverErrors, traffic.totals.requests),
                }),
                hue: traffic.totals.serverErrors > 0 ? "red" : "green",
              },
              {
                id: "clients",
                label: t("tileClients"),
                value: format.number(traffic.totals.uniqueIps),
              },
              {
                id: "bandwidth",
                label: t("tileBandwidth"),
                value: formatBytes(format, traffic.totals.bytes),
              },
            ]}
          />
          <SectionCard icon={BarChart2} title={t("chartTitle")}>
            <HostTrafficChart timeline={traffic.timeline} />
          </SectionCard>
        </>
      ) : (
        <Card padding={5}>
          <EmptyState
            title={t("trafficOffTitle")}
            description={t("trafficOffDescription")}
            isCompact
          />
        </Card>
      )}

      <Grid columns={{ minWidth: 360, max: 2 }} gap={4}>
        <SectionCard
          icon={Server}
          title={tProxyHosts("upstreams")}
          action={
            canManage ? (
              <Button
                variant="ghost"
                size="sm"
                label={tCommon("edit")}
                href={editorSectionHref(host.uuid, "upstreams")}
              />
            ) : undefined
          }
        >
          <VStack gap={3}>
            <List density="compact">
              {host.upstreams.map((upstream) => (
                <ListItem key={upstream} label={upstream} />
              ))}
            </List>
            <Text type="body" size="sm" color="secondary">
              {detail.healthChecks.active
                ? t("activeChecks", {
                    uri: detail.healthChecks.active.uri ?? "/",
                    interval: detail.healthChecks.active.interval ?? t("defaultValue"),
                  })
                : t("noActiveChecks")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {detail.healthChecks.passive
                ? t("passiveChecks", {
                    maxFails: detail.healthChecks.passive.maxFails ?? 1,
                    duration: detail.healthChecks.passive.failDuration ?? t("defaultValue"),
                  })
                : t("noPassiveChecks")}
            </Text>
            <UpstreamHealthPanel hostId={host.id} />
          </VStack>
        </SectionCard>

        <SectionCard icon={ListChecks} title={t("configurationTitle")}>
          <VStack gap={3}>
            {(detail.protections.active.length > 0 || detail.certificate) && (
              <HStack gap={3} vAlign="center" wrap="wrap">
                {detail.protections.active.length > 0 && (
                  <HostProtectionBadges protections={detail.protections} />
                )}
                {detail.certificate && (
                  <CertificateDaysCell
                    days={detail.certificate.daysLeft}
                    name={detail.certificate.name}
                  />
                )}
              </HStack>
            )}
            <List hasDividers density="compact">
              {detail.sections.map((summary) => (
                <ListItem
                  key={summary.section}
                  label={t(`sections.${summary.section}`)}
                  description={factText(summary.facts)}
                  href={canManage ? editorSectionHref(host.uuid, summary.section) : undefined}
                />
              ))}
            </List>
          </VStack>
        </SectionCard>
      </Grid>

      {traffic && (
        <Grid columns={{ minWidth: 360, max: 2 }} gap={4}>
          <SectionCard icon={BarChart2} title={t("pathsTitle")}>
            {traffic.paths.length === 0 ? (
              <EmptyState title={t("chartEmpty")} isCompact />
            ) : (
              <Table
                data={traffic.paths.map((row) => ({ ...row, id: row.path }))}
                columns={pathColumns}
                idKey="id"
                density={density}
              />
            )}
          </SectionCard>
          <SectionCard icon={BarChart2} title={tProxyHosts("statusCodes")}>
            {traffic.statuses.length === 0 ? (
              <EmptyState title={t("chartEmpty")} isCompact />
            ) : (
              <Table
                data={traffic.statuses.map((row) => ({ ...row, id: String(row.status) }))}
                columns={statusColumns}
                idKey="id"
                density={density}
              />
            )}
          </SectionCard>
        </Grid>
      )}

      {auditRows && (
        <SectionCard icon={History} title={t("auditTitle")}>
          {auditRows.length === 0 ? (
            <EmptyState title={t("auditEmpty")} isCompact />
          ) : (
            <Table data={auditRows} columns={auditColumns} idKey="id" density={density} />
          )}
        </SectionCard>
      )}
    </VStack>
  );
}
