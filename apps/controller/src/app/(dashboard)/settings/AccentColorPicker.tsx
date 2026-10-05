"use client";

import { useEffect, useState } from "react";
import { Circle } from "lucide-react";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { InfoAlert, StatusAlert, WarnAlert } from "@/src/components/ui/FormLayout";
import { ACCENT_COLORS, type AccentColor, isAccentColor } from "@/src/lib/branding/accent-colors";
import type { RegistryField } from "./RegistrySettingsBlock";

// Whole class names, so Tailwind's scan finds them.
const SWATCH: Record<AccentColor, string> = {
  pink: "text-pink-vivid",
  purple: "text-purple-vivid",
  blue: "text-blue-vivid",
  cyan: "text-cyan-vivid",
  teal: "text-teal-vivid",
  green: "text-green-vivid",
  orange: "text-orange-vivid",
  red: "text-red-vivid",
};

/**
 * A form like any other block's, so the page's save bar stages it for Review & apply. The choice
 * lives in a hidden input: SelectableCard's own checkbox carries no name. The pick is previewed on
 * this page by repainting <html>, and the live accent is put back on leaving it.
 */
export function AccentColorPicker({
  field,
  state,
  formAction,
}: {
  field: RegistryField | undefined;
  state: { success: boolean; message?: string } | null;
  formAction: (payload: FormData) => void;
}) {
  const t = useTranslations("settings");
  const stored = field && isAccentColor(field.value) ? field.value : "pink";
  const [selected, setSelected] = useState<AccentColor>(stored);

  useEffect(() => {
    const root = document.documentElement;
    const live = root.dataset.cpmAccent;
    root.dataset.cpmAccent = selected;
    return () => {
      if (live) root.dataset.cpmAccent = live;
    };
  }, [selected]);

  if (!field) return null;
  const locked = field.pinned === true;

  return (
    <form action={formAction}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={3}>{field.label}</Heading>
          <Text type="supporting" color="secondary">
            {field.description}
          </Text>
        </VStack>
        {locked && <WarnAlert title={t("accentColorPinned", { env: field.env })} />}
        {state?.message && <StatusAlert message={state.message} success={state.success} />}
        <input type="hidden" name={field.key} value={selected} />
        <Grid columns={{ minWidth: 120, max: 4 }} gap={2}>
          {ACCENT_COLORS.map((color) => (
            <SelectableCard
              key={color}
              label={t(`accentColors.${color}`)}
              variant={color === selected ? color : "default"}
              isSelected={color === selected}
              isDisabled={locked}
              onChange={() => setSelected(color)}
              padding={3}
              // Dashed while another is previewed, so the saved one stays findable.
              className={color === stored && color !== selected ? "cpm-accent-saved" : undefined}
            >
              <HStack gap={2} vAlign="center">
                <Circle aria-hidden className={`size-5 shrink-0 fill-current ${SWATCH[color]}`} />
                <Text type="body">{t(`accentColors.${color}`)}</Text>
                {color === stored && (
                  <Text type="supporting" color="secondary" className="ml-auto">
                    {t("accentColorSaved")}
                  </Text>
                )}
              </HStack>
            </SelectableCard>
          ))}
        </Grid>
        {/* Below the swatches, so appearing does not shift what was just clicked. */}
        {selected !== stored && <InfoAlert title={t("accentColorPreview")} />}
      </VStack>
    </form>
  );
}
