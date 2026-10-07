"use client";

import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useTranslations } from "next-intl";
import { useTableDensity } from "@/components/ui/TableDensity";
import { FormCard } from "@/src/components/ui/FormLayout";
import type { OutboundCallState, OutboundCallView, OutboundKind } from "@/src/lib/offline";

const STATE_DOT: Record<OutboundCallState, "success" | "neutral" | "warning"> = {
  on: "success",
  offline: "warning",
  switchedOff: "neutral",
  configured: "success",
  internal: "success",
};

const KIND_COLOR: Record<OutboundKind, "orange" | "blue" | "gray"> = {
  internet: "orange",
  configured: "blue",
  internal: "gray",
};

/** Every connection the registry knows, so an operator can see what offline mode leaves running. */
export function OutboundCallsList({ calls }: { calls: OutboundCallView[] }) {
  const t = useTranslations("settings.outbound");
  const density = useTableDensity();

  type Row = OutboundCallView & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "id",
      header: t("columns.connection"),
      width: proportional(2),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold">
            {t(`calls.${row.id}.name`)}
          </Text>
          <Text type="body" size="sm" color="secondary">
            {t(`calls.${row.id}.description`)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "kind",
      header: t("columns.kind"),
      width: pixel(170),
      renderCell: (row) => (
        <Token size="sm" color={KIND_COLOR[row.kind]} label={t(`kinds.${row.kind}`)} />
      ),
    },
    {
      key: "state",
      header: t("columns.state"),
      width: pixel(200),
      renderCell: (row) => (
        <HStack gap={2} vAlign="center">
          <StatusDot variant={STATE_DOT[row.state]} label={t(`states.${row.state}`)} />
          <Text size="sm">{t(`states.${row.state}`)}</Text>
        </HStack>
      ),
    },
  ];

  return (
    <FormCard title={t("listTitle")}>
      <VStack gap={3}>
        <Text size="sm" color="secondary">
          {t("listDescription")}
        </Text>
        <Table
          density={density}
          data={calls.map((call) => ({ ...call }))}
          columns={columns}
          idKey="id"
        />
      </VStack>
    </FormCard>
  );
}
