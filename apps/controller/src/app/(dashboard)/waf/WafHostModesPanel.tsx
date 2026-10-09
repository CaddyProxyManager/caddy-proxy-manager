"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@astryxdesign/core/Badge";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { useEmptyValue } from "@/components/ui/empty-value";
import { editorSectionHref } from "@/src/lib/proxy-hosts/editor-sections";
import type { WafEngineMode, WafHostMode, WafModeSource } from "@/src/lib/security/waf-hosts";
import { setHostWafEnabledAction } from "./actions";
import { setDashboardWafEnabledAction } from "../settings/actions";
import { settingsHref } from "../settings/sections";

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

export function WafHostModesPanel({
  hosts,
  manageableHostIds,
  canEditDashboard,
}: {
  hosts: WafHostMode[];
  manageableHostIds: number[];
  /** The dashboard host's WAF is a setting, so it takes settings:write rather than a host grant. */
  canEditDashboard: boolean;
}) {
  const t = useTranslations("waf");
  const tSettings = useTranslations("settings");
  const tNav = useTranslations("nav");
  const format = useAppFormatter();
  const emptyValue = useEmptyValue();
  const router = useRouter();
  // Flipped at once and held until the refresh brings the new mode, or dropped on a failure.
  const [pending, setPending] = useState<Map<number, boolean>>(new Map());
  const [shownHosts, setShownHosts] = useState(hosts);
  if (shownHosts !== hosts) {
    setShownHosts(hosts);
    setPending(new Map());
  }

  const setWaf = async (row: WafHostMode, enabled: boolean) => {
    setPending((current) => new Map(current).set(row.id, enabled));
    const result = row.dashboard
      ? await setDashboardWafEnabledAction(enabled).then((settings) => ({
          status: settings.success ? "success" : "error",
          message: settings.message,
        }))
      : await setHostWafEnabledAction(row.id, enabled);
    if (result.status === "error") {
      toast.error(result.message);
      setPending((current) => {
        const next = new Map(current);
        next.delete(row.id);
        return next;
      });
      return;
    }
    toast.success(result.message);
    router.refresh();
  };

  const columns: Column<WafHostMode>[] = [
    {
      id: "waf",
      label: tNav("waf"),
      width: 80,
      render: (row) => (
        <Switch
          label={t("hostWafToggle", {
            name: row.dashboard ? tSettings("dashboardHostTitle") : row.name,
          })}
          isLabelHidden
          value={pending.get(row.id) ?? row.mode !== "Off"}
          isDisabled={
            !(row.dashboard ? canEditDashboard : manageableHostIds.includes(row.id)) ||
            pending.has(row.id)
          }
          onChange={(enabled) => void setWaf(row, enabled)}
        />
      ),
    },
    {
      id: "name",
      label: t("host"),
      render: (row) => (
        <VStack gap={0}>
          {row.dashboard ? (
            <Link href={settingsHref("dashboard")}>{tSettings("dashboardHostTitle")}</Link>
          ) : (
            <Link href={editorSectionHref(row.id, "protection")}>{row.name}</Link>
          )}
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
