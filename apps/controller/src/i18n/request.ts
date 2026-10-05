import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, resolveLocale } from "@/src/lib/locale";
import { TIME_ZONE_COOKIE, resolveTimeZone } from "@/src/lib/locale/time-zone";
import { requestDisplayPreferences } from "@/src/lib/users/display-preferences";

/**
 * vinext discovers this file by path and registers the `next-intl/config` alias itself, so there
 * is no `createNextIntlPlugin` in next.config.mjs - the wrapper reads `next/package.json` and
 * throws under Vite. Moving or renaming this file silently disables next-intl.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerList, preferences] = await Promise.all([
    cookies(),
    headers(),
    requestDisplayPreferences(),
  ]);
  const locale = resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerList.get("accept-language"),
  );

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    // The account's zone, else the cookie the browser writes (lib/locale/time-zone.ts), else UTC.
    // Set explicitly either way so server and browser format alike - unset, next-intl logs
    // ENVIRONMENT_FALLBACK on the first server render of any translated page.
    timeZone: preferences?.timeZone ?? resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value),
  };
});
