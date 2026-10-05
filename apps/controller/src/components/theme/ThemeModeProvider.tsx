"use client";

import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, type ThemeMode } from "@/src/lib/users/theme-mode";

interface ThemeModeContextValue {
  /** The stored preference - "system" included, unresolved. */
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

/** The preference the user picked; "system" stays "system". Resolved light/dark: `useTheme()`. */
export function useThemeMode(): ThemeModeContextValue {
  const ctx = use(ThemeModeContext);
  if (!ctx) {
    throw new Error("useThemeMode must be used inside <ThemeModeProvider>");
  }
  return ctx;
}

function persist(mode: ThemeMode) {
  // Lax: it only picks a colour, and must survive top-level navigation back in.
  /* biome-ignore lint/suspicious/noDocumentCookie: Cookie Store is Chromium-only and async,
     so a reload could race the write. */
  document.cookie = `${THEME_COOKIE}=${mode}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * Owns the colour-mode preference and hands it to Astryx's `<Theme>`. `initialMode` comes from the
 * cookie the server read, so the first client render matches `<html data-theme>` - no flash.
 */
export function ThemeModeProvider({
  initialMode,
  children,
}: {
  initialMode: ThemeMode;
  children: ReactNode;
}) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    persist(next);
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <ThemeModeContext value={value}>
      <Theme theme={neutralTheme} mode={mode}>
        {children}
      </Theme>
    </ThemeModeContext>
  );
}
