/**
 * Events that cannot happen under the current settings, and why: their switches are greyed out
 * with the reason, rather than left on promising something that never arrives. Each check is the
 * same condition the source of the event tests, so the two cannot disagree.
 */

import type { NotificationCategory } from "./events";

export const UNAVAILABLE_REASONS = [
  "accessLogOff",
  "accountLockOff",
  "accountDisableOff",
  "updateCheckOff",
  "geoipOff",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** As lib/caddy/index.ts decides it: managed CrowdSec forces the access log on, in JSON. */
export async function accessLogReadable(): Promise<boolean> {
  const { getCrowdSecSettings, getLoggingSettings } = await import("../settings");
  const [logging, crowdsec] = await Promise.all([getLoggingSettings(), getCrowdSecSettings()]);
  return (
    (crowdsec.enabled && crowdsec.mode === "managed") ||
    (logging?.enabled === true && (logging.format ?? "json") === "json")
  );
}

export async function unavailableNotificationCategories(): Promise<
  Partial<Record<NotificationCategory, UnavailableReason>>
> {
  const [registry, { getSetting }, { geoipEnabled }, { geoipCredentials }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
    import("../agent/geoip"),
    import("../geoip/update-check"),
  ]);
  const [accessLog, lock, disable, updateCheck, geoip, credentials] = await Promise.all([
    accessLogReadable(),
    getSetting(registry.accountLockEnabled),
    getSetting(registry.accountLockDisableEnabled),
    getSetting(registry.updateCheckEnabled),
    geoipEnabled(),
    geoipCredentials(),
  ]);

  const unavailable: Partial<Record<NotificationCategory, UnavailableReason>> = {};
  if (!accessLog) unavailable.upstreamErrors = "accessLogOff";
  if (!lock) unavailable.adminLocked = "accountLockOff";
  if (!disable) unavailable.accountDisabled = "accountDisableOff";
  if (!updateCheck) unavailable.updateAvailable = "updateCheckOff";
  // The controller downloads only with both; without them there is no update to fail.
  if (!geoip || !credentials.accountId || !credentials.licenseKey) unavailable.geoip = "geoipOff";
  return unavailable;
}

/** The same, keyed by every Settings field it greys out: a switch and the numbers that tune it. */
export async function unavailableNotificationSettings(): Promise<
  Record<string, UnavailableReason>
> {
  const [registry, unavailable] = await Promise.all([
    import("../settings/registry"),
    unavailableNotificationCategories(),
  ]);
  const fields: Partial<Record<NotificationCategory, { key: string }[]>> = {
    upstreamErrors: [
      registry.notifyUpstreamErrors,
      registry.notifyUpstreamErrorCount,
      registry.notifyUpstreamErrorMinutes,
    ],
    adminLocked: [registry.notifyAdminLocked],
    accountDisabled: [registry.notifyAccountDisabled],
    updateAvailable: [registry.notifyUpdateAvailable],
    geoip: [registry.notifyGeoipFailed],
  };
  const result: Record<string, UnavailableReason> = {};
  for (const [category, reason] of Object.entries(unavailable)) {
    for (const field of fields[category as NotificationCategory] ?? []) result[field.key] = reason;
  }
  return result;
}
