/**
 * The reader's time zone travels like the language (see `locale/index.ts`): the browser writes a cookie
 * and `src/i18n/request.ts` hands it to next-intl, so server and browser renders agree. Without the
 * cookie the page renders in UTC.
 */

export const TIME_ZONE_COOKIE = "cpm-tz";

/** A year, matching the locale and theme cookies. */
export const TIME_ZONE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const DEFAULT_TIME_ZONE = "UTC";

/** Canonical IANA name or undefined: the cookie is client-written, and `Intl` throws on junk. */
export function parseTimeZone(value: string | null | undefined): string | undefined {
  if (!value || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function resolveTimeZone(cookieValue: string | null | undefined): string {
  return parseTimeZone(cookieValue) ?? DEFAULT_TIME_ZONE;
}
