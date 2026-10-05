/**
 * Which `settings` rows each navigation section writes. Spelled out, never derived: section ids
 * and storage keys differ (`dns-providers` writes `dns_provider`). Framework-free so the
 * server-side health resolver does not pull in the navigation's icons.
 */

import type { useTranslations } from "next-intl";

/** The review sheet's name for a staged change; deliberately not the navigation's label. */
export type SectionKeys = { label: string; keys: readonly string[] };

export const SECTION_STORAGE_KEYS: Record<string, SectionKeys> = {
  general: { label: "General", keys: ["general"] },
  acme: { label: "ACME Server", keys: ["acme"] },
  "default-response": { label: "Default Response", keys: ["default_response"] },
  avatars: { label: "User Avatars", keys: ["avatars"] },
  branding: { label: "Branding", keys: ["config:accent_color", "branding"] },
  updates: { label: "Updates", keys: ["update_settings"] },
  "caddy-build": { label: "Caddy Build", keys: ["caddy_build"] },
  "global-caddy-config": { label: "Global Caddyfile", keys: ["global_caddy_config"] },
  "http-cache": { label: "HTTP Cache", keys: ["http_cache"] },
  dashboard: { label: "Dashboard Host", keys: ["dashboard"] },
  "dns-providers": { label: "DNS Providers", keys: ["dns_provider", "cloudflare"] },
  "dns-resolvers": { label: "DNS Resolvers", keys: ["dns"] },
  "upstream-dns": { label: "Upstream DNS", keys: ["upstream_dns_resolution"] },
  "trusted-proxies": { label: "Trusted Proxies", keys: ["trusted_proxies"] },
  "http-protocols": { label: "HTTP Versions", keys: ["http_protocols"] },
  compression: { label: "Compression", keys: ["compression"] },
  tailscale: { label: "Tailscale", keys: ["tailscale"] },
  geoblock: { label: "Geo-Block", keys: ["geoblock"] },
  "rate-limit": { label: "Rate Limiting", keys: ["rate_limit"] },
  crowdsec: { label: "CrowdSec", keys: ["crowdsec"] },
  "error-pages": { label: "Error Pages", keys: ["error_pages"] },
  authentik: { label: "Authentik", keys: ["authentik"] },
  "forward-auth": { label: "Forward Auth", keys: ["forward_auth"] },
  "password-policy": { label: "Password Policy", keys: ["password_policy"] },
  "two-factor": { label: "Two-factor Sign-in", keys: ["two_factor_policy"] },
  metrics: { label: "Metrics", keys: ["metrics"] },
  logging: { label: "Logging", keys: ["logging"] },
  waf: { label: "WAF", keys: ["waf"] },
};

/** Empty for a section that writes another table. */
export function storageKeysForSection(id: string): readonly string[] {
  return SECTION_STORAGE_KEYS[id]?.keys ?? [];
}

/** First section to name a key keeps it. */
const SECTION_BY_STORAGE_KEY = new Map<string, { id: string; label: string }>();
for (const [id, entry] of Object.entries(SECTION_STORAGE_KEYS)) {
  for (const key of entry.keys) {
    if (!SECTION_BY_STORAGE_KEY.has(key))
      SECTION_BY_STORAGE_KEY.set(key, { id, label: entry.label });
  }
}

export function sectionForStorageKey(key: string): { id: string; label: string } | null {
  return SECTION_BY_STORAGE_KEY.get(key) ?? null;
}

// ─── Messages ────────────────────────────────────────────────────────────────

// The catalog key is composed at runtime, so tsc cannot check it -
// `tests/unit/settings/section-keys-messages.test.ts` asserts every section has an entry matching `label`.

type SettingsTranslator = ReturnType<typeof useTranslations<"settings">>;

/** A section id as a catalog key segment: `default-response` is `defaultResponse`. */
export function stagedLabelMessageName(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase());
}

/** A key no section claims keeps its own name. */
export function stagedChangeLabel(
  t: SettingsTranslator,
  change: { sectionId: string | null; label: string },
): string {
  if (!change.sectionId || !(change.sectionId in SECTION_STORAGE_KEYS)) return change.label;
  const translate = t as unknown as (key: string) => string;
  return translate(`stagedLabels.${stagedLabelMessageName(change.sectionId)}`);
}
