/** The controller holds the MaxMind licence (../geoip/updater.ts); agents fetch from it. */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONTROLLER_GEOIP_ROUTE,
  GEOIP_EDITIONS,
  type FleetConfig,
  type GeoipEdition,
} from "@cpm/shared";
import { config } from "../config";

/**
 * The data volume, the one place this non-root process can write. Read per call: tests repoint
 * it, and capturing it at import depends on module load order.
 */
function geoipDir(): string {
  return process.env.GEOIP_DIR || join(process.cwd(), "data", "geoip");
}

export function geoipDatabasePath(edition: GeoipEdition): string {
  return join(geoipDir(), `${edition}.mmdb`);
}

/** Size and mtime, not a hash: the updater replaces files wholesale, so mtime always changes. */
export function geoipEtag(path: string): string {
  const stat = statSync(path);
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** The editions this controller currently holds on disk. */
export function installedGeoipEditions(): GeoipEdition[] {
  return GEOIP_EDITIONS.filter((edition) => existsSync(geoipDatabasePath(edition)));
}

export type GeoipDatabaseInfo = {
  edition: GeoipEdition;
  /**
   * The file's mtime, not MaxMind's `build_epoch`: reading that means loading the whole database,
   * and when the updater breaks - what the tile exists to catch - mtime is what stops moving.
   */
  updatedAt: Date;
};

/** Never throws: a database swapped in underneath drops out of the list rather than 500ing. */
export function installedGeoipDatabases(): GeoipDatabaseInfo[] {
  const databases: GeoipDatabaseInfo[] = [];
  for (const edition of installedGeoipEditions()) {
    try {
      databases.push({ edition, updatedAt: statSync(geoipDatabasePath(edition)).mtime });
    } catch {
      // Deleted between the listing and the stat.
    }
  }
  return databases;
}

/** Whole days since the freshest database was written, or null when none are present. */
export function geoipDatabaseAgeDays(
  databases: GeoipDatabaseInfo[],
  now = Date.now(),
): number | null {
  if (databases.length === 0) return null;
  const newest = Math.max(...databases.map((database) => database.updatedAt.getTime()));
  return Math.max(0, Math.floor((now - newest) / 86_400_000));
}

/**
 * Unset infers from databases or credentials on disk, so an upgrade does not read as switched
 * off, nor a fresh enable as unconfigured before its first download.
 */
export async function geoipEnabled(): Promise<boolean> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const toggle = await getSetting(registry.geoipEnabled);
  if (toggle !== null) return toggle;

  if (installedGeoipEditions().length > 0) return true;
  const [accountId, licenseKey] = await Promise.all([
    getSetting(registry.geoipAccountId),
    getSetting(registry.geoipLicenseKey),
  ]);
  return accountId.trim().length > 0 && licenseKey.trim().length > 0;
}

/** `BASE_URL`, since a remote agent needs a public address and this is built on push, not ask. */
export async function geoipFleetConfig(): Promise<FleetConfig["geoip"]> {
  if (!(await geoipEnabled())) return null;

  // Gated on the files too: before the first download lands, agents would 404 daily.
  const editions = installedGeoipEditions();
  if (editions.length === 0) return null;

  return {
    url: `${config.baseUrl.replace(/\/+$/, "")}${CONTROLLER_GEOIP_ROUTE}`,
    editions: [...editions],
  };
}
