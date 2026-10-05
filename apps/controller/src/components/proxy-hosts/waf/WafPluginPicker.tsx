"use client";

import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useWafPluginOptions } from "./WafPresetOptions";

type Props = {
  value: number[];
  onChange: (ids: number[]) => void;
  description: string;
  /** Plugins only load alongside the CRS, so the picker says so while it is off. */
  crsLoaded: boolean;
  isReadOnly?: boolean;
};

/** The caller owns the hidden `wafPluginIds` input, so it submits even while this is unmounted. */
export function WafPluginPicker({ value, onChange, description, crsLoaded, isReadOnly }: Props) {
  const t = useTranslations("waf");
  const plugins = useWafPluginOptions();

  if (plugins.length === 0) {
    return (
      <VStack gap={1}>
        <Text type="body" size="sm" weight="semibold">
          {t("pluginsLabel")}
        </Text>
        <Text type="body" size="xsm" color="secondary">
          {t("pluginsNoneYet")}
        </Text>
      </VStack>
    );
  }

  return (
    <MultiSelector
      label={t("pluginsLabel")}
      description={crsLoaded ? description : t("pluginsNeedCrs")}
      options={plugins.map((plugin) => ({
        value: String(plugin.id),
        label: plugin.name,
      }))}
      value={value.map(String)}
      onChange={(next) => onChange(next.map(Number))}
      triggerDisplay="badges"
      placeholder={t("pluginsPlaceholder")}
      hasSearch={plugins.length > 15}
      isReadOnly={isReadOnly}
    />
  );
}
