/**
 * A database an administrator uploads instead of downloading, as an offline deployment must. It
 * is opened before it replaces anything, so a corrupt file or another edition never reaches the
 * agents; from there it takes the same path as a download.
 */

import { GEOIP_EDITIONS, type GeoipEdition } from "@cpm/shared";
import { Reader } from "maxmind";
import { logAuditEvent } from "../audit";
import { domainError } from "../errors/domain-error";
import { setSetting } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";
import { shareGeoipDatabase } from "./replicas";
import {
  GEOIP_DOWNLOADS_KEY,
  type GeoipDownloadState,
  getGeoipDownloadState,
  installGeoipDatabase,
  looksLikeMmdb,
  MAX_ARCHIVE_BYTES,
} from "./updater";

export function isGeoipEdition(value: unknown): value is GeoipEdition {
  return (GEOIP_EDITIONS as readonly unknown[]).includes(value);
}

/** The build date the file declares, `YYYY-MM-DD`. Throws a domain error for anything unusable. */
export function readUploadedDatabase(edition: GeoipEdition, bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw domainError("geoipDownloadTooLarge", { max: MAX_ARCHIVE_BYTES }, { status: 413 });
  }
  if (!looksLikeMmdb(bytes)) throw domainError("geoipUploadInvalid", { edition }, { status: 400 });
  let reader: Reader<Record<string, unknown>>;
  try {
    reader = new Reader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    // A lookup walks the tree into the data section, which the metadata alone never touches.
    reader.get("1.1.1.1");
  } catch {
    throw domainError("geoipUploadInvalid", { edition }, { status: 400 });
  }
  const type = reader.metadata.databaseType;
  if (type !== edition) {
    throw domainError("geoipUploadWrongEdition", { edition, type }, { status: 400 });
  }
  return reader.metadata.buildEpoch.toISOString().slice(0, 10);
}

export async function uploadGeoipDatabase(
  edition: GeoipEdition,
  bytes: Uint8Array,
  actorUserId: number,
): Promise<{ build: string }> {
  const build = readUploadedDatabase(edition, bytes);
  installGeoipDatabase(edition, bytes);
  await shareGeoipDatabase(edition, bytes);

  const state = await getGeoipDownloadState();
  // A cache of what is on disk, as the updater keeps it: never part of a staged change set.
  await outsideStagingScope(() =>
    setSetting<GeoipDownloadState>(GEOIP_DOWNLOADS_KEY, {
      ...state,
      builds: { ...state.builds, [edition]: build },
    }),
  );

  await logAuditEvent({
    userId: actorUserId,
    action: "geoip_uploaded",
    entityType: "geoip_database",
    summary: `Uploaded GeoIP database ${edition}`,
    data: { edition, build, bytes: bytes.byteLength },
  });

  // Agents re-check the route on every push; the new ETag makes them download.
  const { pushFleetConfig } = await import("../agent/fleet-config");
  await pushFleetConfig();
  return { build };
}
