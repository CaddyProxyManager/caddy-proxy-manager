"use client";

import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useWafPresetOptions } from "./WafPresetOptions";

type Props = {
  value: number[];
  onChange: (ids: number[]) => void;
  description: string;
  isReadOnly?: boolean;
};

/** The caller owns the hidden `wafPresetIds` input, so it submits even while this is unmounted. */
export function WafPresetPicker({ value, onChange, description, isReadOnly }: Props) {
  const t = useTranslations("waf");
  const presets = useWafPresetOptions();

  if (presets.length === 0) {
    return (
      <VStack gap={1}>
        <Text type="body" size="sm" weight="semibold">
          {t("presetsLabel")}
        </Text>
        <Text type="body" size="xsm" color="secondary">
          {t("presetsNoneYet")}
        </Text>
      </VStack>
    );
  }

  return (
    <MultiSelector
      label={t("presetsLabel")}
      description={description}
      options={presets.map((preset) => ({ value: String(preset.id), label: preset.name }))}
      value={value.map(String)}
      onChange={(next) => onChange(next.map(Number))}
      triggerDisplay="badges"
      placeholder={t("presetsPlaceholder")}
      hasSearch={presets.length > 15}
      isReadOnly={isReadOnly}
    />
  );
}
