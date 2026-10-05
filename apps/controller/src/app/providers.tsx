"use client";

import type { ReactNode } from "react";
import NextLink from "next/link";
import { Toaster } from "sonner";
import { NextIntlClientProvider } from "next-intl";
import type { AbstractIntlMessages } from "next-intl";
import { LinkProvider } from "@astryxdesign/core/Link";
import { LocaleProvider } from "@/src/components/locale/LocaleProvider";
import { TimeZoneSync } from "@/src/components/locale/TimeZoneSync";
import { NumberLocaleProvider } from "@/src/components/locale/use-app-formatter";
import { ThemeModeProvider } from "@/src/components/theme/ThemeModeProvider";
import type { Locale, LocalePreference } from "@/src/lib/locale";
import type { ThemeMode } from "@/src/lib/users/theme-mode";

export default function Providers({
  children,
  initialThemeMode,
  locale,
  localePreference,
  messages,
  timeZone,
  timeZoneFromAccount = false,
  numberLocale = null,
}: {
  children: ReactNode;
  initialThemeMode: ThemeMode;
  locale: Locale;
  localePreference: LocalePreference;
  messages: AbstractIntlMessages;
  timeZone: string;
  /** Chosen on Profile: the browser's own zone must not overwrite it. */
  timeZoneFromAccount?: boolean;
  /** The account's number grouping as a locale; null keeps the page's. */
  numberLocale?: string | null;
}) {
  return (
    /* Explicit, because vinext's SSR environment does not see next-intl's request config: left to
       infer, the SSR pass throws and the page 500s. A mismatched time zone would render every
       timestamp twice, differently. */
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
      {!timeZoneFromAccount && <TimeZoneSync timeZone={timeZone} />}
      {/* Hands the locale to Astryx, whose components carry strings this app never writes. */}
      <LocaleProvider locale={locale} preference={localePreference}>
        {/* Astryx owns light/dark: tokens are light-dark() pairs, so the browser resolves
            "system" itself. */}
        <ThemeModeProvider initialMode={initialThemeMode}>
          {/* So every Astryx link stays a client-side navigation, not a full page load. */}
          <LinkProvider component={NextLink}>
            <NumberLocaleProvider value={numberLocale}>
              {children}
              <Toaster richColors position="bottom-right" />
            </NumberLocaleProvider>
          </LinkProvider>
        </ThemeModeProvider>
      </LocaleProvider>
    </NextIntlClientProvider>
  );
}
