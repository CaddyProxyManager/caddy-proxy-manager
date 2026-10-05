"use client";

import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { Switch } from "@/src/components/ui/FormBooleanControls";

/** On by default: a host follows the global CrowdSec setting unless it opts out here. */
export function CrowdSecFields({ enabled: initial }: { enabled?: boolean }) {
  const t = useTranslations("proxyHosts");
  const moduleDisabledReason = useDisabledReason("crowdsec");
  const [enabled, setEnabled] = useState(initial ?? true);

  return (
    <Card>
      <input type="hidden" name="crowdsecPresent" value="1" />
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("crowdsec")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("crowdsecDescription")}
            </Text>
          </VStack>
          {/* Never disabled: a disabled switch submits nothing, which would read as opted out. */}
          <Switch
            label={t("enableCrowdsec")}
            isLabelHidden
            htmlName="crowdsecEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>
        {moduleDisabledReason && (
          <Banner
            status="warning"
            title={t("crowdsecUnavailable")}
            description={moduleDisabledReason}
          />
        )}
      </VStack>
    </Card>
  );
}
