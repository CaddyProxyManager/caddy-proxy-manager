"use client";

import { History } from "lucide-react";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { VStack } from "@astryxdesign/core/Stack";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { Timestamp } from "@/components/ui/Timestamp";
import { useTableDensity } from "@/components/ui/TableDensity";
import type { HostAuditRow } from "@/lib/proxy-hosts/detail-types";
import { SectionCard } from "./SectionCard";

/** A host's last changes, on its overview. */
export function HostAuditCard({ rows }: { rows: HostAuditRow[] }) {
  const t = useTranslations("proxyHosts.detail");
  const tAuditLog = useTranslations("auditLog");
  const density = useTableDensity();

  const columns: TableColumn<HostAuditRow>[] = [
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
    <SectionCard icon={History} title={t("auditTitle")}>
      {rows.length === 0 ? (
        <EmptyState title={t("auditEmpty")} isCompact />
      ) : (
        <Table data={rows} columns={columns} idKey="id" density={density} />
      )}
    </SectionCard>
  );
}
