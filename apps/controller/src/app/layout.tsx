import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { getLocale, getMessages, getTimeZone, getTranslations } from "next-intl/server";
import { getLocaleDirection } from "@astryxdesign/core/i18n";
import "./globals.css";
import Providers from "./providers";
import { getAccentColor } from "@/src/lib/branding/accent-color";
import { getAppName } from "@/src/lib/branding/app-name";
import { LOCALE_COOKIE, parsePreference } from "@/src/lib/locale";
import { THEME_COOKIE, parseThemeMode, themeAttr, themeColor } from "@/src/lib/users/theme-mode";
import { requestDisplayPreferences } from "@/src/lib/users/display-preferences";
import { numberLocaleFor } from "@/src/lib/locale/number-format";
import { clientMessages } from "@/src/lib/locale/client-messages";

// From the same cookie `<html data-theme>` is rendered from, so the browser's own chrome is tinted
// with the mode the page is actually in rather than the one the OS would have chosen.
export async function generateViewport(): Promise<Viewport> {
  const cookieStore = await cookies();
  return { themeColor: themeColor(parseThemeMode(cookieStore.get(THEME_COOKIE)?.value)) };
}

// A function so the description follows the locale. The forward auth portal opts out of the title
// template, as it runs on someone else's domain. It stays in <head> only because next.config.mjs
// sets `htmlLimitedBots`.
export async function generateMetadata(): Promise<Metadata> {
  const [t, appName] = await Promise.all([getTranslations("common"), getAppName()]);
  return {
    title: {
      default: appName,
      template: `%s · ${appName}`,
    },
    description: t("metaDescription"),
    // Unconditional: a database read here would run on every request. The route 404s with no
    // upload, which the browser treats like a missing /favicon.ico.
    icons: { icon: "/api/branding/favicon" },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const themeMode = parseThemeMode(cookieStore.get(THEME_COOKIE)?.value);
  // Resolved in src/i18n/request.ts alone. The preference is read separately, since the switcher
  // must tell "chose English" from "we guessed English".
  const locale = await getLocale();
  // Without what only the server renders: this goes out in every document's RSC payload.
  const messages = clientMessages(await getMessages());
  // Resolved from the time zone cookie in the same request config, and handed to the client
  // provider so the browser formats timestamps in the zone the server just did.
  const timeZone = await getTimeZone();
  const localePreference = parsePreference(cookieStore.get(LOCALE_COOKIE)?.value);
  const accent = await getAccentColor();
  // The account's, when it chose: they follow it to every browser (lib/users/display-preferences.ts).
  const preferences = await requestDisplayPreferences();

  return (
    // data-theme is rendered from the cookie so the first paint is already in the right mode;
    // omitted for "system", which Astryx's reset.css reads as `color-scheme: light dark`.
    // suppressHydrationWarning stays - Astryx's Theme writes data-theme itself once mounted.
    <html
      lang={locale}
      dir={getLocaleDirection(locale)}
      data-theme={themeAttr(themeMode)}
      data-cpm-accent={accent}
      suppressHydrationWarning
    >
      <body>
        <Providers
          initialThemeMode={themeMode}
          locale={locale}
          localePreference={localePreference}
          messages={messages}
          timeZone={timeZone}
          timeZoneFromAccount={Boolean(preferences?.timeZone)}
          numberLocale={numberLocaleFor(preferences?.numberFormat)}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
