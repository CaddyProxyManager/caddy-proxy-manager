"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";

type Props = {
  value?: number[];
};

export function WafRuleExclusions({ value }: Props) {
  const t = useTranslations("proxyHosts");
  const [ids, setIds] = useState<number[]>(value ?? []);
  const [draft, setDraft] = useState<number | null>(null);

  function addId() {
    if (draft === null || !Number.isInteger(draft) || draft <= 0) return;
    setIds((prev) => (prev.includes(draft) ? prev : [...prev, draft]));
    setDraft(null);
  }

  return (
    <VStack gap={2}>
      <input type="hidden" name="wafExcludedRuleIds" value={JSON.stringify(ids)} />

      <VStack gap={1}>
        <Text type="body" size="sm" weight="semibold">
          {t("excludedRuleIds")}
        </Text>
        <Text type="body" size="xsm" color="secondary">
          {t("wafRuleExclusionsHelp")}
        </Text>
      </VStack>

      {ids.length > 0 && (
        <HStack gap={2} wrap="wrap">
          {ids.map((id) => (
            <Token
              key={id}
              size="sm"
              label={String(id)}
              onRemove={() => setIds((prev) => prev.filter((x) => x !== id))}
            />
          ))}
        </HStack>
      )}

      <HStack gap={2} vAlign="end">
        <NumberInput
          hasNumberSteppers
          label={t("ruleId")}
          isLabelHidden
          placeholder={t("ruleId")}
          value={draft}
          onChange={setDraft}
          isIntegerOnly
          min={1}
          width={160}
          onEnter={addId}
          // onEnter does not prevent the default, which would submit the host form mid-edit.
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
        <IconButton
          variant="ghost"
          size="sm"
          label={t("addExcludedRuleId")}
          icon={<Plus />}
          onClick={addId}
        />
      </HStack>
    </VStack>
  );
}
