"use client";

/**
 * An L4 host's page: its upstreams, a line per editor section linking into the editor, and its
 * recent changes. Presentational; the route gathers everything in lib/l4/detail.
 */

import { ListChecks, Server } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { HostPageTabs } from "@/components/host-history/HostPageTabs";
import { HostAuditCard } from "@/components/proxy-hosts/detail/HostAuditCard";
import { ProxyHostHeader } from "@/components/proxy-hosts/detail/ProxyHostHeader";
import { SectionCard } from "@/components/proxy-hosts/detail/SectionCard";
import { l4HostHeader, type L4HostDetail } from "@/lib/l4/detail-types";
import {
  l4EditorSectionHref,
  l4ProxyHostDetailHref,
  l4ProxyHostHistoryHref,
} from "@/lib/l4/editor-sections";
import type { HostAuditRow } from "@/lib/proxy-hosts/detail-types";
import type { SectionFact } from "@/lib/proxy-hosts/section-summary";

type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

export function L4HostDetailView({
  detail,
  auditRows,
  canManage,
  traffic = null,
}: {
  detail: L4HostDetail;
  auditRows: HostAuditRow[] | null;
  canManage: boolean;
  /** Its connections, where L4 traffic monitoring is on. */
  traffic?: ReactNode;
}) {
  const t = useTranslations("proxyHosts.detail");
  const tL4 = useTranslations("l4ProxyHosts.detail");
  const tCommon = useTranslations("common");
  const tProxyHosts = useTranslations("proxyHosts");
  const tFacts = useTranslations("proxyHosts.detail.facts") as unknown as DynamicTranslate;
  const { host, healthChecks } = detail;

  const factText = (facts: SectionFact[]) =>
    facts.map((fact) => tFacts(fact.code, fact.values)).join(" · ");

  return (
    <VStack gap={5}>
      <ProxyHostHeader
        layer4
        header={l4HostHeader(host)}
        tabs={
          canManage && (
            <HostPageTabs
              active="overview"
              overviewHref={l4ProxyHostDetailHref(host.uuid)}
              editHref={l4EditorSectionHref(host.uuid)}
              historyHref={l4ProxyHostHistoryHref(host.uuid)}
            />
          )
        }
      />

      {traffic}

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
                href={l4EditorSectionHref(host.uuid, "upstreams")}
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
              {healthChecks.active
                ? tL4("activeChecks", {
                    port: healthChecks.active.port === null ? "none" : healthChecks.active.port,
                    interval: healthChecks.active.interval ?? t("defaultValue"),
                  })
                : t("noActiveChecks")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {healthChecks.passive
                ? t("passiveChecks", {
                    maxFails: healthChecks.passive.maxFails ?? 1,
                    duration: healthChecks.passive.failDuration ?? t("defaultValue"),
                  })
                : t("noPassiveChecks")}
            </Text>
          </VStack>
        </SectionCard>

        <SectionCard icon={ListChecks} title={t("configurationTitle")}>
          <List hasDividers density="compact">
            {detail.sections.map((summary) => (
              <ListItem
                key={summary.section}
                label={t(`sections.${summary.section}`)}
                description={factText(summary.facts)}
                href={canManage ? l4EditorSectionHref(host.uuid, summary.section) : undefined}
              />
            ))}
          </List>
        </SectionCard>
      </Grid>

      {auditRows && <HostAuditCard rows={auditRows} />}
    </VStack>
  );
}
