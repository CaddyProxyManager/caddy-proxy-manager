import { domainError } from "../errors/domain-error";

/** The expiry choices Profile offers. "custom" is the date picker; the API takes a date as before. */
export const TOKEN_EXPIRY_PRESETS = ["30d", "90d", "1y", "never", "custom"] as const;

export type TokenExpiryPreset = (typeof TOKEN_EXPIRY_PRESETS)[number];

export const DEFAULT_TOKEN_EXPIRY: TokenExpiryPreset = "90d";

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESET_DAYS: Record<"30d" | "90d" | "1y", number> = { "30d": 30, "90d": 90, "1y": 365 };

/** Anything else falls back to the default, never to "never". */
export function tokenExpiryPreset(value: unknown): TokenExpiryPreset {
  return isTokenExpiryPreset(value) ? value : DEFAULT_TOKEN_EXPIRY;
}

export function isTokenExpiryPreset(value: unknown): value is TokenExpiryPreset {
  return (TOKEN_EXPIRY_PRESETS as readonly unknown[]).includes(value);
}

/** Undefined for never; `custom` passes its own date through for the model to validate. */
export function resolveTokenExpiry(
  preset: TokenExpiryPreset,
  custom: string | undefined,
  now: Date = new Date(),
): string | undefined {
  if (preset === "never") return undefined;
  // Not "never": a picker left empty is a mistake, not a choice.
  if (preset === "custom") {
    if (!custom?.trim()) throw domainError("tokenExpiryInvalid");
    return custom;
  }
  return new Date(now.getTime() + PRESET_DAYS[preset] * DAY_MS).toISOString();
}
