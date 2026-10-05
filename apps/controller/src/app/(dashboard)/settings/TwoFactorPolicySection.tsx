"use client";

import { useState } from "react";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { FormCard, StatusAlert } from "@/src/components/ui/FormLayout";
import {
  MAX_MFA_GRACE_DAYS,
  MFA_POLICY_MODES,
  type MfaPolicyMode,
  type TwoFactorPolicySettings,
} from "@/src/lib/auth/two-factor/mfa-policy";

export function TwoFactorPolicySection({
  policy,
  state,
  formAction,
}: {
  policy: TwoFactorPolicySettings;
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.mfaPolicy");
  const [mode, setMode] = useState<MfaPolicyMode>(policy.mode);
  const [graceDays, setGraceDays] = useState<number | undefined>(policy.graceDays);
  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          <VStack gap={1}>
            <Text type="label">{t("modeLabel")}</Text>
            <HStack>
              <SegmentedControl
                label={t("modeLabel")}
                value={mode}
                onChange={(next) => setMode(next as MfaPolicyMode)}
              >
                {MFA_POLICY_MODES.map((option) => (
                  <SegmentedControlItem key={option} value={option} label={t(`modes.${option}`)} />
                ))}
              </SegmentedControl>
            </HStack>
            {/* SegmentedControl has no form name. */}
            <input type="hidden" name="mode" value={mode} />
            <Text type="supporting" color="secondary">
              {t(`modeHelp.${mode}`)}
            </Text>
          </VStack>
          {mode !== "off" && (
            <NumberInput
              hasNumberSteppers
              label={t("graceDays")}
              description={t("graceDaysHelp")}
              htmlName="graceDays"
              min={0}
              max={MAX_MFA_GRACE_DAYS}
              isIntegerOnly
              value={graceDays}
              onChange={setGraceDays}
            />
          )}
          <Text type="supporting" color="secondary">
            {t("breakGlass")}
          </Text>
        </VStack>
      </form>
    </FormCard>
  );
}
