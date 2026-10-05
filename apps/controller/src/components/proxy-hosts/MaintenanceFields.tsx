"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import type { HostMaintenanceConfig } from "@/lib/proxy-hosts/maintenance";
import { MAINTENANCE_RETRY_AFTER_MAX } from "@/lib/proxy-hosts/maintenance-limits";
import { Switch } from "@/src/components/ui/FormBooleanControls";

/** The fields stay mounted while off, so switching it off in the editor keeps the rest. */
export function MaintenanceFields({ maintenance }: { maintenance?: HostMaintenanceConfig | null }) {
  const t = useTranslations("proxyHosts");
  const [enabled, setEnabled] = useState(maintenance?.enabled ?? false);
  const [retryAfter, setRetryAfter] = useState<number | null>(maintenance?.retryAfter ?? null);
  const [bypass, setBypass] = useState((maintenance?.bypassCidrs ?? []).join("\n"));
  const [body, setBody] = useState(maintenance?.body ?? "");

  return (
    <Card>
      <input type="hidden" name="maintenancePresent" value="1" />
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("maintenance")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("maintenanceDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableMaintenance")}
            isLabelHidden
            htmlName="maintenanceEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>
        {enabled && (
          <Banner
            status="warning"
            title={t("maintenanceActiveTitle")}
            description={t("maintenanceActiveDescription")}
          />
        )}
        <TextArea
          {...NO_SPELLCHECK}
          label={t("maintenanceBypass")}
          isOptional
          htmlName="maintenanceBypass"
          placeholder={"203.0.113.7\n10.0.0.0/8"}
          value={bypass}
          onChange={setBypass}
          rows={3}
          description={t("maintenanceBypassHelp")}
        />
        <NumberInput
          startIcon={Clock}
          hasNumberSteppers
          units={t("maintenanceRetryAfterUnit")}
          label={t("maintenanceRetryAfter")}
          isOptional
          htmlName="maintenanceRetryAfter"
          min={1}
          max={MAINTENANCE_RETRY_AFTER_MAX}
          isIntegerOnly
          value={retryAfter}
          onChange={setRetryAfter}
          description={t("maintenanceRetryAfterHelp")}
        />
        <TextArea
          {...NO_SPELLCHECK}
          label={t("maintenanceBody")}
          isOptional
          htmlName="maintenanceBody"
          value={body}
          onChange={setBody}
          rows={4}
          description={t("maintenanceBodyHelp")}
        />
      </VStack>
    </Card>
  );
}
