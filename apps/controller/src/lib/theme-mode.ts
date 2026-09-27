/**
 * Colour-mode preference: what the user picked, not the mode in effect - "system" stays "system".
 * Astryx handles it natively: `<Theme mode="system">` leaves `data-theme` off `<html>`, which its
 * reset.css maps to `color-scheme: light dark`, so no JS and no media-query listener.
 */
export type ThemeMode = "light" | "dark" | "system";

/**
 * Cookie rather than localStorage: the server must know the mode to render `<html data-theme>`
 * on first paint. Not HttpOnly - the toggle writes it, and a display preference needs no guard.
 */
export const THEME_COOKIE = "cpm-theme";

/** A year - long enough that the preference outlives ordinary session churn. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/** Narrows an untrusted cookie value, falling back to following the OS. */
export function parseThemeMode(value: string | undefined): ThemeMode {
  return isThemeMode(value) ? value : "system";
}

/**
 * The `data-theme` value for `<html>`, or undefined to leave it off. Astryx's reset.css reads a
 * missing attribute as `color-scheme: light dark`, so "system" must omit it - the server cannot
 * know the OS preference, and guessing causes a flash.
 */
export function themeAttr(mode: ThemeMode): "light" | "dark" | undefined {
  return mode === "system" ? undefined : mode;
}

/**
 * `--color-background-body` in both modes, repeated here because `<meta name="theme-color">` takes
 * a literal - keep in step with the `light-dark()` pair in src/app/astryx-variants.css.
 */
const BODY_COLOR = { light: "#f1f1f1", dark: "#000000" } as const;

/**
 * What the browser tints its own chrome with, so a phone's status bar matches the page instead of
 * the default white. "system" has to hand the choice back to the OS through `media`; the other two
 * are a single value, since `data-theme` overrides the OS and the media query would then be wrong.
 */
export function themeColor(mode: ThemeMode): string | { media: string; color: string }[] {
  if (mode !== "system") return BODY_COLOR[mode];
  return [
    { media: "(prefers-color-scheme: light)", color: BODY_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: BODY_COLOR.dark },
  ];
}
