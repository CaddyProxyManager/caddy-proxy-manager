"use client";

import { Copy } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { WAF_QUICK_TEMPLATES, appendQuickTemplate } from "@/lib/waf-templates";

/**
 * Shared by the global WAF settings and the host WAF card. `onInsert` takes an updater, so the
 * inserted id can move past the ids already in the directives.
 */
export function WafQuickTemplates({
  idOffset = 0,
  onInsert,
}: {
  idOffset?: number;
  onInsert: (update: (directives: string) => string) => void;
}) {
  const t = useTranslations("waf");
  return (
    <VStack gap={2}>
      <Text type="body" size="lg" weight="semibold">
        {t("quickTemplates")}
      </Text>
      <HStack gap={2} wrap="wrap">
        {WAF_QUICK_TEMPLATES.map((template) => (
          <Button
            key={template.id}
            type="button"
            size="sm"
            variant="secondary"
            icon={<Copy />}
            label={t(`templates.${template.id}`)}
            onClick={() =>
              onInsert((directives) => appendQuickTemplate(directives, template, idOffset))
            }
          />
        ))}
      </HStack>
    </VStack>
  );
}
