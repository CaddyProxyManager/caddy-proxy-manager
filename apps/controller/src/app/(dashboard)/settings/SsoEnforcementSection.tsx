"use client";

import { useState } from "react";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { FormCard, StatusAlert } from "@/src/components/ui/FormLayout";
import { MAX_BREAK_GLASS_ACCOUNTS, type SsoEnforcement } from "@/src/lib/auth/sso-enforcement";

export type BreakGlassCandidate = { id: number; label: string };

export function SsoEnforcementSection({
  policy,
  candidates,
  state,
  formAction,
}: {
  policy: SsoEnforcement;
  /** Accounts with a password of their own: the only ones a break-glass exemption helps. */
  candidates: BreakGlassCandidate[];
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings.ssoEnforcement");
  const [enforced, setEnforced] = useState(policy.enforced);
  const [allowLdap, setAllowLdap] = useState(policy.allowLdap);
  const [breakGlass, setBreakGlass] = useState(policy.breakGlassUserIds.map(String));
  return (
    <FormCard>
      <form action={formAction}>
        <VStack gap={3}>
          {state?.message && <StatusAlert message={state.message} success={state.success} />}
          <Switch
            label={t("enforce")}
            description={t("enforceHelp")}
            value={enforced}
            onChange={setEnforced}
          />
          {/* Switch and MultiSelector have no form names. */}
          <input type="hidden" name="enforced" value={String(enforced)} />
          <MultiSelector
            label={t("breakGlass")}
            description={t("breakGlassHelp", { max: MAX_BREAK_GLASS_ACCOUNTS })}
            size="sm"
            triggerDisplay="labels"
            options={candidates.map((candidate) => ({
              value: String(candidate.id),
              label: candidate.label,
            }))}
            value={breakGlass}
            onChange={(next) => setBreakGlass(next.slice(0, MAX_BREAK_GLASS_ACCOUNTS))}
          />
          <input type="hidden" name="breakGlassUserIds" value={breakGlass.join(",")} />
          <Switch
            label={t("allowLdap")}
            description={t("allowLdapHelp")}
            value={allowLdap}
            onChange={setAllowLdap}
          />
          <input type="hidden" name="allowLdap" value={String(allowLdap)} />
          <Text type="supporting" color="secondary">
            {t("liftHelp")}
          </Text>
        </VStack>
      </form>
    </FormCard>
  );
}
