/**
 * The global rate-limit zones and the never-limited allowlist, stored as the `rate_limit` setting.
 * Server only: the allowlist is checked with node:net.
 */
import { normalizeCidr } from "../access-lists/rules";
import { domainError } from "../errors/domain-error";
import { type GlobalRateLimitSettings, RATE_LIMIT_MAX_ALLOWLIST, zonesOf } from "./rate-limit";

type Refuse = Parameters<typeof zonesOf>[1];

function build(value: unknown, refuse: Refuse): GlobalRateLimitSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const zones = zonesOf(raw.zones, refuse);
  const rawAllow = Array.isArray(raw.allowlist) ? raw.allowlist : [];
  if (rawAllow.length > RATE_LIMIT_MAX_ALLOWLIST) {
    refuse("rateLimitAllowlistTooLong", { max: RATE_LIMIT_MAX_ALLOWLIST });
  }
  const allowlist: string[] = [];
  for (const entry of rawAllow.slice(0, RATE_LIMIT_MAX_ALLOWLIST)) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const cidr = normalizeCidr(entry);
    if (!cidr) {
      refuse("rateLimitAllowlistEntryInvalid", { value: entry.trim().slice(0, 80) });
      continue;
    }
    if (!allowlist.includes(cidr)) allowlist.push(cidr);
  }
  return { enabled: raw.enabled === true, zones, allowlist };
}

/** A stored blob: what Caddy would refuse is dropped rather than failing every host. */
export function sanitizeGlobalRateLimit(value: unknown): GlobalRateLimitSettings | null {
  if (!value || typeof value !== "object") return null;
  return build(value, () => {});
}

/** From Settings or the API: anything Caddy would reject is refused. */
export function normalizeGlobalRateLimitInput(value: unknown): GlobalRateLimitSettings {
  return build(value, (code, params) => {
    throw domainError(code, params, { status: 400 });
  });
}
