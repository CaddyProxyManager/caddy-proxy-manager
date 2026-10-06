"use client";

import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";

type Props = {
  /** The rule-id list exclusions replaced; startup moves it, so it is normally empty. */
  value?: number[];
};

export function WafRuleExclusions({ value }: Props) {
  const t = useTranslations("proxyHosts");
  const legacy = value ?? [];

  return (
    <VStack gap={2}>
      {/* Posted back unchanged, so a save never drops ids startup has yet to move. */}
      <input type="hidden" name="wafExcludedRuleIds" value={JSON.stringify(legacy)} />
      <VStack gap={1}>
        <Text type="body" size="sm" weight="semibold">
          {t("wafExclusionsTitle")}
        </Text>
        <Text type="supporting">{t("wafExclusionsMoved")}</Text>
      </VStack>
      <Link href="/waf">{t("wafExclusionsManage")}</Link>
      {legacy.length > 0 && (
        <VStack gap={1}>
          <Text type="supporting">{t("wafLegacyExclusions")}</Text>
          <HStack gap={2} wrap="wrap">
            {legacy.map((id) => (
              <Token key={id} size="sm" label={String(id)} />
            ))}
          </HStack>
        </VStack>
      )}
    </VStack>
  );
}
