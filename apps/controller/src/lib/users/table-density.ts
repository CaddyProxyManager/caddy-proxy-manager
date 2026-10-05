/**
 * Per-user table density, set on Profile. Astryx's densities change padding, never text, so each
 * keeps astryx-variants.css's 14px. No server imports: the Profile control and provider read it.
 */
export const TABLE_DENSITIES = ["compact", "balanced", "spacious"] as const;

export type TableDensity = (typeof TABLE_DENSITIES)[number];

export const DEFAULT_TABLE_DENSITY: TableDensity = "balanced";

export function isTableDensity(value: unknown): value is TableDensity {
  return typeof value === "string" && (TABLE_DENSITIES as readonly string[]).includes(value);
}
