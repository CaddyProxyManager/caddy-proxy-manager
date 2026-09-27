"use client";

import { Languages } from "lucide-react";
import { useTranslations } from "next-intl";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { LOCALES, type Locale } from "@/src/lib/locale";
import { useLocalePreference } from "./LocaleProvider";

/**
 * Each language named in itself, so someone who cannot read the current UI can still find theirs.
 * `Intl.DisplayNames` rather than a hand-written table: it already knows every tag we might add.
 */
function endonym(locale: Locale): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** Renders nothing while English is the only catalog: a one-entry menu is a dead control. */
export function LocaleSwitcher() {
  const t = useTranslations("common.locale");
  const { locale, preference, setLocale } = useLocalePreference();

  if (LOCALES.length < 2) return null;

  return (
    <DropdownMenu
      hasChevron={false}
      button={{
        variant: "ghost",
        size: "sm",
        icon: <Languages />,
        label: t("switcherLabel"),
        isIconOnly: true,
      }}
      placement="above"
      alignment="end"
      items={[
        {
          // Clearing the cookie hands the choice back to Accept-Language and navigator.languages.
          id: "auto",
          label: t("automatic"),
          description: preference.source === "chosen" ? undefined : endonym(locale),
          onClick: () => setLocale(null),
        },
        { type: "divider" },
        ...LOCALES.map((candidate) => ({
          id: candidate,
          label: endonym(candidate),
          onClick: () => setLocale(candidate),
        })),
      ]}
    />
  );
}
