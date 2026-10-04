/**
 * The accent colours the dashboard can take, each one of Astryx's hues. Yellow and gray are left
 * out: neither holds the contrast an accent's text and controls need.
 */
export const ACCENT_COLORS = [
  "pink",
  "purple",
  "blue",
  "cyan",
  "teal",
  "green",
  "orange",
  "red",
] as const;

export type AccentColor = (typeof ACCENT_COLORS)[number];

export const DEFAULT_ACCENT_COLOR: AccentColor = "pink";

export function isAccentColor(value: unknown): value is AccentColor {
  return ACCENT_COLORS.includes(value as AccentColor);
}
