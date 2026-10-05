/** Client safe: the blocked-sources page and the Block dialogs share these. */

export const BLOCKED_SOURCE_KINDS = ["ip", "cidr", "country", "continent", "asn"] as const;
export type BlockedSourceKind = (typeof BLOCKED_SOURCE_KINDS)[number];

export const CONTINENT_CODES = ["AF", "AN", "AS", "EU", "NA", "OC", "SA"] as const;

/** Offered by the Block dialogs; any future date is accepted too. */
export const BLOCK_EXPIRY_PRESETS = [
  { id: "1h", labelKey: "oneHour", seconds: 3600 },
  { id: "24h", labelKey: "oneDay", seconds: 86_400 },
  { id: "7d", labelKey: "sevenDays", seconds: 7 * 86_400 },
  { id: "30d", labelKey: "thirtyDays", seconds: 30 * 86_400 },
  { id: "never", labelKey: "never", seconds: null },
] as const;
export type BlockExpiryPreset = (typeof BLOCK_EXPIRY_PRESETS)[number]["id"];

export const MAX_BLOCKED_SOURCES = 5000;
export const MAX_BLOCK_REASON = 500;

export type BlockedSource = {
  id: number;
  kind: BlockedSourceKind;
  value: string;
  reason: string;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
};

export function isBlockedSourceKind(value: unknown): value is BlockedSourceKind {
  return (BLOCKED_SOURCE_KINDS as readonly unknown[]).includes(value);
}

/** The expiry a preset means, from `now`. */
export function expiryFromPreset(preset: BlockExpiryPreset, now: number): string | null {
  const seconds = BLOCK_EXPIRY_PRESETS.find((entry) => entry.id === preset)?.seconds ?? null;
  return seconds === null ? null : new Date(now + seconds * 1000).toISOString();
}
