"use client";

import { createContext, use, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  type Locale,
  type LocalePreference,
  negotiateLocale,
  preferenceCookieValue,
} from "@/src/lib/locale";

interface LocaleContextValue {
  locale: Locale;
  /** What the cookie says - "unset"/"detected" both render as automatic in the switcher. */
  preference: LocalePreference;
  /** Null goes back to following the browser. */
  setLocale: (locale: Locale | null) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocalePreference(): LocaleContextValue {
  const ctx = use(LocaleContext);
  if (!ctx) {
    throw new Error("useLocalePreference must be used inside <LocaleProvider>");
  }
  return ctx;
}

function persist(value: string | null) {
  const base = `${LOCALE_COOKIE}=`;
  /* biome-ignore lint/suspicious/noDocumentCookie: same reasoning as ThemeModeProvider -
     the Cookie Store API is Chromium-only and its async set would let router.refresh()
     race the write. */
  document.cookie =
    value === null
      ? `${base}; path=/; max-age=0; SameSite=Lax`
      : `${base}${value}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * Also hands the locale to Astryx, whose components carry their own strings. Messages come via
 * the RSC payload after `router.refresh()`, so the bundle holds one catalog, not every locale.
 */
export function LocaleProvider({
  locale,
  preference,
  children,
}: {
  locale: Locale;
  preference: LocalePreference;
  children: ReactNode;
}) {
  const router = useRouter();

  const setLocale = useCallback(
    (next: Locale | null) => {
      persist(
        preferenceCookieValue(
          next === null ? { source: "unset" } : { source: "chosen", locale: next },
        ),
      );
      router.refresh();
    },
    [router],
  );

  // Chrome trims `Accept-Language` to one language; `navigator.languages` keeps the full list.
  useEffect(() => {
    if (preference.source === "chosen") return;

    const detected = negotiateLocale(navigator.languages ?? []);
    if (!detected) return;

    if (detected !== locale) {
      persist(preferenceCookieValue({ source: "detected", locale: detected }));
      router.refresh();
    } else if (preference.source === "unset" || preference.locale !== detected) {
      // Already right - record it without a round trip.
      persist(preferenceCookieValue({ source: "detected", locale: detected }));
    }
  }, [locale, preference, router]);

  const value = useMemo(() => ({ locale, preference, setLocale }), [locale, preference, setLocale]);

  return (
    <LocaleContext value={value}>
      <InternationalizationProvider locale={locale}>{children}</InternationalizationProvider>
    </LocaleContext>
  );
}
