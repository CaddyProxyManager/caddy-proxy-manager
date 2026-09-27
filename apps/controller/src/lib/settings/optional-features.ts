/**
 * Analytics and GeoIP decide whether a whole service runs, so saving one drops cached ClickHouse
 * config, re-pushes fleet credentials, starts or stops containers and kicks the GeoIP download.
 */

import { geoipDatabaseAgeDays, geoipEnabled, installedGeoipDatabases } from "../agent/geoip";
import { editionsBehind, getGeoipUpdateCheck } from "../geoip/update-check";
import { getGeoipDownloadState } from "../geoip/updater";
import { geoipDownloadErrorMessage } from "../geoip/messages";
import { storedErrorMessage } from "../actions";
import { isAnalyticsEnabled } from "../clickhouse/client";
import * as registry from "./registry";
import { resolveSetting, saveSettings, type SettingSource } from "./resolve";

export type AnalyticsView = {
  enabled: boolean;
  /** True while nothing is stored, so `enabled` was inferred from whether a password is set. */
  inferred: boolean;
  /** So the page can say a variable is still overriding it. */
  source: SettingSource;
  url: string;
  user: string;
  database: string;
  retentionDays: number;
  /** The value itself never reaches the browser. */
  hasPassword: boolean;
};

export type GeoipView = {
  enabled: boolean;
  inferred: boolean;
  source: SettingSource;
  accountId: string;
  hasLicenseKey: boolean;
  installedEditions: string[];
  /** MaxMind publishes twice a week, so a working updater never gets far past a few days. */
  databaseAgeDays: number | null;
  lastCheckedAt: string | null;
  checkError: string | null;
  /** Tells "MaxMind published nothing" from "the updater stopped fetching", which age cannot. */
  editionsBehind: string[];
  downloadError: string | null;
  updateIntervalHours: number;
};

export async function analyticsView(): Promise<AnalyticsView> {
  const [toggle, enabled, url, user, database, retentionDays, password] = await Promise.all([
    resolveSetting(registry.analyticsEnabled),
    isAnalyticsEnabled(),
    resolveSetting(registry.clickhouseUrl),
    resolveSetting(registry.clickhouseUser),
    resolveSetting(registry.clickhouseDb),
    resolveSetting(registry.clickhouseRetentionDays),
    resolveSetting(registry.clickhousePassword),
  ]);

  return {
    enabled,
    inferred: toggle.value === null,
    source: toggle.source,
    url: url.value,
    user: user.value,
    database: database.value,
    retentionDays: retentionDays.value,
    hasPassword: password.value.trim().length > 0,
  };
}

/** `t` is the root translator, so stored failures reach the page already translated. */
export async function geoipView(t: Parameters<typeof storedErrorMessage>[0]): Promise<GeoipView> {
  const installed = installedGeoipDatabases();
  const interval = await resolveSetting(registry.geoipUpdateIntervalHours);
  const [toggle, enabled, accountId, licenseKey, check, downloads] = await Promise.all([
    resolveSetting(registry.geoipEnabled),
    geoipEnabled(),
    resolveSetting(registry.geoipAccountId),
    resolveSetting(registry.geoipLicenseKey),
    // Refreshes behind this call once older than the interval; never waits on MaxMind.
    getGeoipUpdateCheck(
      installed.map((database) => database.edition),
      interval.value * 60 * 60 * 1000,
    ),
    getGeoipDownloadState(),
  ]);

  return {
    enabled,
    inferred: toggle.value === null,
    source: toggle.source,
    accountId: accountId.value,
    hasLicenseKey: licenseKey.value.trim().length > 0,
    installedEditions: installed.map((database) => database.edition),
    databaseAgeDays: geoipDatabaseAgeDays(installed),
    lastCheckedAt: check.checkedAt,
    checkError: check.error ? storedErrorMessage(t, check.error, check.errorCode) : null,
    editionsBehind: editionsBehind(check.available, installed),
    downloadError: geoipDownloadErrorMessage(t, downloads.error, downloads.failures),
    updateIntervalHours: interval.value,
  };
}

/**
 * Resolves the tri-state stored value (unset means "infer") to a boolean, so a deployment with a
 * ClickHouse password in `.env` opens setup with analytics on, not off while running.
 */
export async function gateDefaults(): Promise<Record<string, boolean>> {
  const { readSmtpConfig } = await import("../email/config");
  const [analytics, geoip, email] = await Promise.all([
    isAnalyticsEnabled(),
    geoipEnabled(),
    readSmtpConfig(),
  ]);
  return {
    [registry.analyticsEnabled.key]: analytics,
    [registry.geoipEnabled.key]: geoip,
    [registry.smtpEnabled.key]: email.status !== "off",
  };
}

/**
 * Order matters: the client forgets old credentials, agents learn where to write, and the
 * container starts last. Exported for setup, which writes through `saveSettings` directly.
 */
export async function propagateOptionalFeatureSettings(): Promise<void> {
  const [{ invalidateClickHouseConfig }, { pushFleetConfig }, { applyManagedServices }] =
    await Promise.all([
      import("../clickhouse/client"),
      import("../agent/fleet-config"),
      import("../agent/managed-services"),
    ]);

  await invalidateClickHouseConfig();
  await pushFleetConfig();
  await applyManagedServices();

  // Not awaited: a first download is tens of megabytes, and saving should not wait on MaxMind.
  const { updateGeoipDatabases } = await import("../geoip/updater");
  void updateGeoipDatabases();
}

/** An empty password keeps the stored one: the form never receives it to send back. */
export async function saveAnalyticsSettings(input: {
  enabled: boolean;
  url: string;
  user: string;
  password: string;
  database: string;
  retentionDays: number;
}): Promise<void> {
  const values: Record<string, unknown> = {
    // Never back to null: the tri-state is for deployments that never saw this page.
    [registry.analyticsEnabled.key]: input.enabled,
    [registry.clickhouseUrl.key]: input.url,
    [registry.clickhouseUser.key]: input.user,
    [registry.clickhouseDb.key]: input.database,
    [registry.clickhouseRetentionDays.key]: input.retentionDays,
  };
  if (input.password.trim().length > 0) {
    values[registry.clickhousePassword.key] = input.password;
  }

  await saveSettings(values);
  await propagateOptionalFeatureSettings();
}

export async function saveGeoipSettings(input: {
  enabled: boolean;
  accountId: string;
  licenseKey: string;
  updateIntervalHours: number;
}): Promise<void> {
  const values: Record<string, unknown> = {
    [registry.geoipEnabled.key]: input.enabled,
    [registry.geoipAccountId.key]: input.accountId,
    [registry.geoipUpdateIntervalHours.key]: input.updateIntervalHours,
  };
  if (input.licenseKey.trim().length > 0) {
    values[registry.geoipLicenseKey.key] = input.licenseKey;
  }

  await saveSettings(values);
  await propagateOptionalFeatureSettings();
}
