import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, resolveLocale } from "@/src/lib/locale";
import { TIME_ZONE_COOKIE, resolveTimeZone } from "@/src/lib/locale/time-zone";

/**
 * vinext discovers this file by path and registers the `next-intl/config` alias itself, so there
 * is no `createNextIntlPlugin` in next.config.mjs - the wrapper reads `next/package.json` and
 * throws under Vite. Moving or renaming this file silently disables next-intl.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerList.get("accept-language"),
  );

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    // The reader's zone, from the cookie the browser writes (lib/locale/time-zone.ts); UTC until it has.
    // Set explicitly either way so server and browser format alike - unset, next-intl logs
    // ENVIRONMENT_FALLBACK on the first server render of any translated page.
    timeZone: resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value),
  };
});
