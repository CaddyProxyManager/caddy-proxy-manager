"use client";

/**
 * How this account's pages look: table density, applied at once, and the time zone and number
 * format, which follow the account to every browser and need a fresh page load to take hold.
 */
import { useMemo, useState } from "react";
import { Rows3 } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { useSetTableDensity, useTableDensity } from "@/components/ui/TableDensity";
import { isTableDensity, TABLE_DENSITIES } from "@/src/lib/users/table-density";
import {
  NUMBER_FORMATS,
  type NumberFormatPreference,
  numberLocaleFor,
} from "@/src/lib/locale/number-format";
import type { DisplayPreferences } from "@/src/lib/users/display-preferences";
import { loadPage } from "@/src/lib/browser/navigation";
import { saveDisplayPreferencesAction, saveTableDensityAction } from "./display-actions";
import { ProfileSection } from "./ProfileSection";

/** The browser's zone list; a short fallback where `supportedValuesOf` is missing. */
function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

const FOLLOW_BROWSER = "browser";
const SAMPLE = 1234567.89;

export function DisplaySection({
  preferences,
  onError,
}: {
  preferences: DisplayPreferences;
  onError: (message: string) => void;
}) {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const currentZone = useTimeZone();
  const density = useTableDensity();
  const setDensity = useSetTableDensity();
  const [savingDensity, setSavingDensity] = useState(false);
  const [timeZone, setTimeZone] = useState(preferences.timeZone ?? FOLLOW_BROWSER);
  const [numberFormat, setNumberFormat] = useState<NumberFormatPreference>(
    preferences.numberFormat,
  );
  const [saving, setSaving] = useState(false);
  const zones = useMemo(timeZones, []);
  const dirty =
    timeZone !== (preferences.timeZone ?? FOLLOW_BROWSER) ||
    numberFormat !== preferences.numberFormat;

  const chooseDensity = async (next: string) => {
    if (!isTableDensity(next) || next === density) return;
    const previous = density;
    setDensity(next);
    setSavingDensity(true);
    try {
      const result = await saveTableDensityAction(next);
      if (!result.ok) {
        setDensity(previous);
        onError(result.error);
      }
    } catch {
      setDensity(previous);
      onError(t("tableDensitySaveFailed"));
    } finally {
      setSavingDensity(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await saveDisplayPreferencesAction({
        timeZone: timeZone === FOLLOW_BROWSER ? null : timeZone,
        numberFormat,
      });
      if (!result.ok) {
        onError(result.error);
        return;
      }
      // The zone and digits are set where the page starts, above anything a refresh re-renders.
      loadPage(window.location.href);
    } catch {
      onError(t("displayPreferences.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const sample = (preference: NumberFormatPreference) =>
    new Intl.NumberFormat(numberLocaleFor(preference) ?? locale).format(SAMPLE);

  return (
    <ProfileSection icon={Rows3} title={t("display")}>
      <VStack gap={4}>
        <VStack gap={2}>
          <SegmentedControl
            label={t("tableDensity")}
            value={density}
            onChange={chooseDensity}
            isDisabled={savingDensity}
          >
            {TABLE_DENSITIES.map((option) => (
              <SegmentedControlItem
                key={option}
                value={option}
                label={t(`tableDensityOptions.${option}`)}
              />
            ))}
          </SegmentedControl>
          <Text type="body" size="sm" color="secondary">
            {t("tableDensityHelp")}
          </Text>
        </VStack>

        <Grid columns={{ minWidth: 240, max: 2 }} gap={3}>
          <Selector
            label={t("displayPreferences.timeZone")}
            description={t("displayPreferences.timeZoneHelp", { zone: currentZone ?? "UTC" })}
            hasSearch
            value={timeZone}
            onChange={(next) => setTimeZone(String(next))}
            options={[
              { value: FOLLOW_BROWSER, label: t("displayPreferences.followBrowser") },
              { type: "divider" as const },
              ...zones.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") })),
            ]}
          />
          <Selector
            label={t("displayPreferences.numberFormat")}
            description={t("displayPreferences.numberFormatHelp")}
            value={numberFormat}
            onChange={(next) => setNumberFormat(next as NumberFormatPreference)}
            options={NUMBER_FORMATS.map((option) => ({
              value: option,
              label:
                option === "auto"
                  ? t("displayPreferences.numberFormatAuto", { sample: sample(option) })
                  : sample(option),
            }))}
          />
        </Grid>
        <HStack justify="end">
          <Button
            variant="primary"
            size="sm"
            label={tCommon("save")}
            isDisabled={!dirty || saving}
            isLoading={saving}
            onClick={save}
          />
        </HStack>
      </VStack>
    </ProfileSection>
  );
}
