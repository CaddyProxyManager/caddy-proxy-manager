"use client";

import type { ReactNode } from "react";
import NextLink from "next/link";
import { Toaster } from "sonner";
import { NextIntlClientProvider } from "next-intl";
import type { AbstractIntlMessages } from "next-intl";
import { LinkProvider } from "@astryxdesign/core/Link";
import { LocaleProvider } from "@/src/components/locale/LocaleProvider";
import { TimeZoneSync } from "@/src/components/locale/TimeZoneSync";
import { ThemeModeProvider } from "@/src/components/theme/ThemeModeProvider";
import type { Locale, LocalePreference } from "@/src/lib/locale";
import type { ThemeMode } from "@/src/lib/theme-mode";

export default function Providers({
  children,
  initialThemeMode,
  locale,
  localePreference,
  messages,
  timeZone,
}: {
  children: ReactNode;
  initialThemeMode: ThemeMode;
  locale: Locale;
  localePreference: LocalePreference;
  messages: AbstractIntlMessages;
  timeZone: string;
}) {
  return (
    /* Explicit, because vinext's SSR environment does not see next-intl's request config: left to
       infer, the SSR pass throws and the page 500s. A mismatched time zone would render every
       timestamp twice, differently. */
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
      <TimeZoneSync timeZone={timeZone} />
      {/* Hands the locale to Astryx, whose components carry strings this app never writes. */}
      <LocaleProvider locale={locale} preference={localePreference}>
        {/* Astryx owns light/dark: tokens are light-dark() pairs, so the browser resolves
            "system" itself. */}
        <ThemeModeProvider initialMode={initialThemeMode}>
          {/* So every Astryx link stays a client-side navigation, not a full page load. */}
          <LinkProvider component={NextLink}>
            {children}
            <Toaster richColors position="bottom-right" />
          </LinkProvider>
        </ThemeModeProvider>
      </LocaleProvider>
    </NextIntlClientProvider>
  );
}
