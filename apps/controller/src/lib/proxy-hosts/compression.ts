/**
 * Response compression through Caddy's built-in `encode` handler: a global switch in Settings, and
 * a per-host override that is stored only when it differs from "follow the global setting".
 */

export const HOST_COMPRESSION_MODES = ["inherit", "on", "off"] as const;
export type HostCompressionMode = (typeof HOST_COMPRESSION_MODES)[number];

export type CompressionSettings = { enabled: boolean };

export const DEFAULT_COMPRESSION_SETTINGS: CompressionSettings = { enabled: true };

export function normalizeCompressionSettings(value: unknown): CompressionSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { enabled: raw.enabled !== false };
}

/** Anything unreadable follows the global setting. */
export function sanitizeHostCompression(value: unknown): HostCompressionMode {
  return HOST_COMPRESSION_MODES.includes(value as HostCompressionMode)
    ? (value as HostCompressionMode)
    : "inherit";
}

export function isCompressionOn(
  global: CompressionSettings | null | undefined,
  host: HostCompressionMode | undefined,
): boolean {
  if (host === "on") return true;
  if (host === "off") return false;
  return (global ?? DEFAULT_COMPRESSION_SETTINGS).enabled;
}

/**
 * No `match`, so Caddy's default content types apply (text, JSON, JS, XML, SVG, fonts), leaving
 * images, archives and video alone. Upgrades, SSE flushes and pre-encoded responses pass through.
 */
export function buildEncodeHandler(): Record<string, unknown> {
  return {
    handler: "encode",
    encodings: { gzip: {}, zstd: {} },
    prefer: ["zstd", "gzip"],
  };
}
