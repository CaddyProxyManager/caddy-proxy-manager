"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { useEmptyValue } from "@/components/ui/empty-value";
import { editorSectionHref } from "@/src/lib/proxy-hosts/editor-sections";
import type { WafEngineMode, WafHostMode, WafModeSource } from "@/src/lib/security/waf-hosts";

const MODE_VARIANT: Record<WafEngineMode, "success" | "warning" | "neutral"> = {
  On: "success",
  DetectionOnly: "warning",
  Off: "neutral",
};

export const MODE_KEY = {
  On: "modeBlocking",
  DetectionOnly: "modeDetectionOnly",
  Off: "modeOff",
} as const satisfies Record<WafEngineMode, string>;

const SOURCE_KEY = {
  global: "modeSourceGlobal",
  host: "modeSourceHost",
  hostOff: "modeSourceHostOff",
  override: "modeSourceOverride",
} as const satisfies Record<WafModeSource, string>;

export function WafHostModesPanel({ hosts }: { hosts: WafHostMode[] }) {
  const t = useTranslations("waf");
  const tNav = useTranslations("nav");
  const format = useAppFormatter();
  const emptyValue = useEmptyValue();

  const columns: Column<WafHostMode>[] = [
    {
      id: "name",
      label: t("host"),
      render: (row) => (
        <VStack gap={0}>
          <Link href={editorSectionHref(row.id, "protection")}>{row.name}</Link>
          <Text type="body" size="sm" color="secondary" maxLines={1}>
            {row.domains.join(", ")}
          </Text>
        </VStack>
      ),
    },
    {
      id: "mode",
      label: t("hostMode"),
      width: 160,
      render: (row) =>
        row.enabled ? (
          <Badge variant={MODE_VARIANT[row.mode]} label={t(MODE_KEY[row.mode])} />
        ) : (
          <Badge label={t("hostDisabled")} />
        ),
    },
    {
      id: "source",
      label: t("hostModeSource"),
      render: (row) => (
        <Text type="body" size="sm" color="secondary">
          {t(SOURCE_KEY[row.source])}
        </Text>
      ),
    },
    {
      id: "events",
      label: t("hostEvents7d"),
      width: 140,
      align: "right",
      render: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {row.events7d === null ? emptyValue : format.number(row.events7d)}
        </Text>
      ),
    },
  ];

  return (
    <VStack gap={6}>
      <VStack gap={1}>
        <Heading level={2}>{tNav("hosts")}</Heading>
        <Text type="body" size="sm" color="secondary">
          {t("hostModesDescription")}
        </Text>
      </VStack>
      <DataTable columns={columns} data={hosts} keyField="id" emptyMessage={t("hostModesEmpty")} />
    </VStack>
  );
}
