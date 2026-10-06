"use client";

import { useTranslations } from "next-intl";
import { Check, X } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import {
  MIN_PASSWORD_LENGTH,
  type PasswordPolicyViolation,
  passwordPolicyViolations,
} from "@/src/lib/auth/password/policy";

/** Every rule, in the order the policy reports them, so the checklist and the error agree. */
const RULES: PasswordPolicyViolation[] = ["length", "case", "number", "special"];

/** The rule as a live checklist rather than a sentence to hold in mind while typing. */
export function PasswordPolicyChecklist({ password }: { password: string }) {
  const t = useTranslations();
  const failing = new Set(passwordPolicyViolations(password));
  const metCount = RULES.length - failing.size;

  return (
    <VStack gap={1}>
      <HStack justify="between" vAlign="center" paddingInline={1}>
        <Text type="label" size="sm" color="secondary">
          {t("auth.passwordChange.policyTitle")}
        </Text>
        <Text type="body" size="sm" color="secondary">
          {t("auth.passwordChange.policyProgress", { met: metCount, total: RULES.length })}
        </Text>
      </HStack>
      <Card padding={4}>
        <VStack gap={2} as="ul" aria-label={t("auth.passwordChange.policyTitle")}>
          {RULES.map((rule) => {
            const isMet = !failing.has(rule);
            return (
              <HStack key={rule} as="li" gap={2} vAlign="center">
                {isMet ? (
                  <Icon icon={Check} size="sm" color="success" />
                ) : (
                  <Icon icon={X} size="sm" color="secondary" />
                )}
                <Text type="body" size="sm" color={isMet ? "primary" : "secondary"}>
                  {t(`passwordPolicy.rule.${rule}`, { min: MIN_PASSWORD_LENGTH })}
                </Text>
              </HStack>
            );
          })}
        </VStack>
      </Card>
    </VStack>
  );
}
