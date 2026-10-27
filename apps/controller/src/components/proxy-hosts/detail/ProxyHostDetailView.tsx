"use client";

/**
 * A proxy host's page: what needs attention, its last day of traffic, its upstreams' live health,
 * a line per editor section linking into the editor, and its recent changes. Presentational, so
 * the docs can render it with sample data; the route gathers everything in lib/proxy-hosts/detail.
 */

import { BarChart2, FlaskConical, ListChecks, Server, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { AttentionList } from "@/components/attention/AttentionList";
import { hasAttentionToShow } from "@/lib/attention/types";
import {
  CertificateDaysCell,
  HostProtectionBadges,
} from "@/components/proxy-hosts/HostInsightCells";
import { UpstreamHealthPanel } from "@/components/proxy-hosts/upstreams/UpstreamHealthPanel";
import { StatTiles } from "@/components/ui/StatTiles";
import { useTableDensity } from "@/components/ui/TableDensity";
import { formatBytes, formatShare } from "@/src/app/(dashboard)/analytics/explore/format";
import { editorSectionHref, proxyHostDetailHref } from "@/lib/proxy-hosts/editor-sections";
import { HostPageTabs } from "@/components/host-history/HostPageTabs";
import type { ProxyHostDetail } from "@/lib/proxy-hosts/detail-types";
import type { HostPathRow, HostStatusRow } from "@/lib/clickhouse/host-traffic";
import type { SectionFact } from "@/lib/proxy-hosts/section-summary";
import type { HostAuditRow } from "@/lib/proxy-hosts/detail-types";
import { HostAuditCard } from "./HostAuditCard";
import { HostTrafficChart } from "./HostTrafficChart";
import { ProxyHostHeader } from "./ProxyHostHeader";
import { SectionCard } from "./SectionCard";

export type { HostAuditRow };

type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

export function ProxyHostDetailView({
  detail,
  auditRows,
  canManage,
  analyticsHref,
  logsHref,
  historyHref = null,
  wafOverride = null,
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
  /** The WAF override panel, for a manager of a host whose WAF blocks; the route owns it. */
  wafOverride?: ReactNode;
}) {
  const t = useTranslations("proxyHosts.detail");
  const tOverview = useTranslations("overview");
  const tAttention = useTranslations("attention");
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

  return (
    <VStack gap={5}>
      <ProxyHostHeader
        header={{
          name: host.name,
          domains: host.domains,
          tags: host.tags,
          status: detail.status,
          analyticsHref,
          logsHref,
        }}
        tabs={
          (historyHref || analyticsHref || logsHref) && (
            <HostPageTabs
              active="overview"
              overviewHref={proxyHostDetailHref(host.uuid)}
              analyticsHref={analyticsHref}
              logsHref={logsHref}
              editHref={canManage ? editorSectionHref(host.uuid) : null}
              historyHref={historyHref}
            />
          )
        }
      />

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

      {wafOverride && (
        <SectionCard icon={FlaskConical} title={tProxyHosts("wafOverride.title")}>
          {wafOverride}
        </SectionCard>
      )}

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

      {auditRows && <HostAuditCard rows={auditRows} />}
    </VStack>
  );
}
