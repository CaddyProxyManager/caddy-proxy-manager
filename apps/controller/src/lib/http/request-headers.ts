/**
 * Bun 1.4 joins duplicate request headers with ", ", so a client's `X-Forwarded-Host` precedes
 * Caddy's. Trust the trailing segment, which the nearest proxy wrote.
 */

/** "" for missing or empty, so "absent" and "present but useless" read alike. */
export function lastHeaderValue(value: string | null | undefined): string {
  if (!value) return "";
  const parts = value.split(",");
  return parts[parts.length - 1]?.trim() ?? "";
}
