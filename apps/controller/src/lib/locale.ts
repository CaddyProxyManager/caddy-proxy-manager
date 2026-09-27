/**
 * A cookie, not a `/[locale]` segment: `src/proxy.ts` authorizes on path prefixes, forward auth
 * runs on someone else's domain, and the REST API is versioned by path.
 */

/** Every locale with a catalog in `messages/`. */
export const LOCALES = ["en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/**
 * Not localStorage: the server renders `<html lang>` before React runs. Not HttpOnly: the client
 * writes it. An `auto:` prefix marks a detected locale, so a later visit can re-detect.
 */
export const LOCALE_COOKIE = "cpm-locale";

const AUTO_PREFIX = "auto:";

/** Matches THEME_COOKIE_MAX_AGE. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function parseLocale(value: string | undefined): Locale | undefined {
  return isLocale(value) ? value : undefined;
}

/** Only a picked locale is authoritative; the others are re-negotiated per request. */
export type LocalePreference =
  | { source: "unset" }
  | { source: "detected"; locale: Locale }
  | { source: "chosen"; locale: Locale };

/** An unknown locale reads as no preference at all. */
export function parsePreference(value: string | undefined): LocalePreference {
  if (!value) return { source: "unset" };
  if (value.startsWith(AUTO_PREFIX)) {
    const locale = parseLocale(value.slice(AUTO_PREFIX.length));
    return locale ? { source: "detected", locale } : { source: "unset" };
  }
  const locale = parseLocale(value);
  return locale ? { source: "chosen", locale } : { source: "unset" };
}

/** `null` means clear it and go back to detecting. */
export function preferenceCookieValue(preference: LocalePreference): string | null {
  switch (preference.source) {
    case "unset":
      return null;
    case "detected":
      return `${AUTO_PREFIX}${preference.locale}`;
    case "chosen":
      return preference.locale;
  }
}

/** Walks up the subtag chain, so `pt-BR` lands on `pt`. */
function matchTag(tag: string): Locale | undefined {
  let candidate = tag.trim().toLowerCase();
  if (!candidate) return undefined;
  while (candidate) {
    const hit = LOCALES.find((locale) => locale.toLowerCase() === candidate);
    if (hit) return hit;
    const cut = candidate.lastIndexOf("-");
    if (cut === -1) return undefined;
    candidate = candidate.slice(0, cut);
  }
  return undefined;
}

/** Undefined rather than the default, so "nothing we have" differs from "asked for English". */
export function negotiateLocale(tags: readonly string[]): Locale | undefined {
  for (const tag of tags) {
    const hit = matchTag(tag);
    if (hit) return hit;
  }
  return undefined;
}

/** Drops `*`, which would otherwise beat a later tag we actually ship. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const weight = q ? Number.parseFloat(q.trim().slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((entry) => entry.tag && entry.tag !== "*" && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.tag);
}

/** The request's `Accept-Language` beats a stored detection, which may predate a browser change. */
export function resolveLocale(
  cookieValue: string | undefined,
  acceptLanguage: string | null,
): Locale {
  const preference = parsePreference(cookieValue);
  if (preference.source === "chosen") return preference.locale;

  const negotiated = negotiateLocale(parseAcceptLanguage(acceptLanguage));
  if (negotiated) return negotiated;

  return preference.source === "detected" ? preference.locale : DEFAULT_LOCALE;
}
