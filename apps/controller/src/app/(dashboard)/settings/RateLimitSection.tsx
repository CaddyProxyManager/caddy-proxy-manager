"use client";

import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useDisabledReason } from "@/components/caddy-modules/ModuleGate";
import { RateLimitZonesEditor } from "@/components/proxy-hosts/protection/RateLimitFields";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import {
  type GlobalRateLimitSettings,
  RATE_LIMIT_MAX_ALLOWLIST,
  hydrateZone,
} from "@/src/lib/proxy-hosts/rate-limit";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { FormCard, StatusAlert } from "@/src/components/ui/FormLayout";

/** Zones every inheriting host takes, and the addresses no zone ever counts. */
export function RateLimitSection({
  rateLimit,
  state,
  formAction,
}: {
  rateLimit: GlobalRateLimitSettings | null;
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.rateLimit");
  const moduleDisabledReason = useDisabledReason("ratelimit");
  const [enabled, setEnabled] = useState(rateLimit?.enabled ?? false);
  const [allowlist, setAllowlist] = useState((rateLimit?.allowlist ?? []).join("\n"));

  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={4}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          {moduleDisabledReason && (
            <Banner status="warning" title={t("unavailable")} description={moduleDisabledReason} />
          )}
          <Text type="body" size="sm" color="secondary">
            {t("help")}
          </Text>
          <Switch
            label={t("enabled")}
            description={t("enabledHelp")}
            htmlName="rateLimitEnabled"
            labelPosition="start"
            labelSpacing="spread"
            value={enabled}
            onChange={setEnabled}
          />
          <RateLimitZonesEditor
            zones={(rateLimit?.zones ?? []).map(hydrateZone)}
            htmlName="rateLimitZonesJson"
          />
          <TextArea
            {...NO_SPELLCHECK}
            label={t("allowlist")}
            description={t("allowlistHelp", { max: RATE_LIMIT_MAX_ALLOWLIST })}
            htmlName="rateLimitAllowlist"
            isOptional
            rows={4}
            placeholder={"10.0.0.0/8\n203.0.113.7"}
            value={allowlist}
            onChange={setAllowlist}
          />
        </VStack>
      </form>
    </FormCard>
  );
}
