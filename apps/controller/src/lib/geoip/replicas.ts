/**
 * Every replica serves the GeoIP databases to agents and reads them itself, but only the leader
 * downloads. It stores each download in `geoip_databases`; the others compare hashes on each
 * heartbeat, or at once when told, and install what changed onto their own data volume.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { GEOIP_EDITIONS, type GeoipEdition } from "@cpm/shared";
import { eq } from "drizzle-orm";
import { geoipDatabasePath } from "../agent/geoip";
import { isClusterShared, onClusterMessage, onClusterSync, sendToCluster } from "../cluster/bus";
import { isLeader } from "../cluster/leader";
import db, { nowIso } from "../db";
import { geoipDatabases } from "../db/schema";
import { installGeoipDatabase } from "./updater";

const CHANGED = "geoip-changed";

/** Per file mtime, so a 70 MB database is hashed once rather than every heartbeat. */
const hashes = new Map<GeoipEdition, { mtimeMs: number; sha256: string }>();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function localHash(edition: GeoipEdition): string | null {
  const path = geoipDatabasePath(edition);
  try {
    const { mtimeMs } = statSync(path);
    const known = hashes.get(edition);
    if (known?.mtimeMs === mtimeMs) return known.sha256;
    const hash = sha256(readFileSync(path));
    hashes.set(edition, { mtimeMs, sha256: hash });
    return hash;
  } catch {
    hashes.delete(edition);
    return null;
  }
}

/** After the leader installs a download: stored for the rest, who are told to fetch it now. */
export async function shareGeoipDatabase(edition: GeoipEdition, bytes: Uint8Array): Promise<void> {
  if (!isClusterShared()) return;
  const row = { sha256: sha256(bytes), data: bytes, updatedAt: nowIso() };
  await db
    .insert(geoipDatabases)
    .values({ edition, ...row })
    .onConflictDoUpdate({ target: geoipDatabases.edition, set: row });
  sendToCluster(CHANGED);
}

/**
 * Installs what the database holds and this volume does not. The leader also stores a file it
 * has that the database lacks: a deployment that downloaded before it had replicas.
 */
export async function syncGeoipDatabases(): Promise<void> {
  if (!isClusterShared()) return;
  const stored = new Map(
    (
      await db
        .select({ edition: geoipDatabases.edition, sha256: geoipDatabases.sha256 })
        .from(geoipDatabases)
    ).map((row) => [row.edition, row.sha256]),
  );
  for (const edition of GEOIP_EDITIONS) {
    const want = stored.get(edition);
    const have = localHash(edition);
    if (want && want !== have) {
      const [row] = await db
        .select({ data: geoipDatabases.data })
        .from(geoipDatabases)
        .where(eq(geoipDatabases.edition, edition));
      if (!row) continue;
      const bytes = new Uint8Array(row.data);
      // Torn or replaced between the two reads: the next sync tries again.
      if (sha256(bytes) !== want) continue;
      installGeoipDatabase(edition, bytes);
      console.log(`[geoip] installed ${edition} from another replica's download`);
    } else if (!want && have && isLeader()) {
      await shareGeoipDatabase(edition, readFileSync(geoipDatabasePath(edition)));
    }
  }
}

onClusterMessage(CHANGED, () => {
  void syncGeoipDatabases().catch((error: unknown) => {
    console.error("[geoip] could not install another replica's download:", error);
  });
});
onClusterSync(() => syncGeoipDatabases());
