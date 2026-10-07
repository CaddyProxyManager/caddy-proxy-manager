/** Background jobs worth an email: GeoIP updates that keep failing, a CRS plugin switched off, a release. */

import type { GeoipUpdateResult } from "../geoip/updater";
import { notify, recordJobFailure, recordJobSuccess } from "./index";

/** A single failed download is routine (a MaxMind blip); three in a row is not. */
export const GEOIP_FAILURE_STREAK = 3;

export async function reportGeoipRun(
  result: Pick<GeoipUpdateResult, "error" | "skipped" | "checkError" | "failures">,
  now = Date.now(),
): Promise<void> {
  if (result.skipped) return;
  if (result.error) {
    const error = result.error;
    await recordJobFailure(
      "geoip",
      GEOIP_FAILURE_STREAK,
      (failures) => ({
        kind: "geoipFailed",
        failures,
        error,
        checkError: result.checkError ?? null,
        editionFailures: result.failures ?? [],
      }),
      now,
    );
  } else {
    await recordJobSuccess("geoip", { kind: "geoipRecovered" }, now);
  }
}

/** A day's quiet: switched back on and refused again the same day is the same story. */
const CRS_QUIET_MS = 24 * 60 * 60_000;

export function reportCrsPluginDisabled(plugin: {
  id: number;
  name: string;
  version: string;
}): Promise<void> {
  return notify(
    `crs-plugin-disabled:${plugin.id}:${plugin.version}`,
    { kind: "crsPluginDisabled", plugin: plugin.name, version: plugin.version },
    CRS_QUIET_MS,
  );
}

export function reportReleaseAvailable(version: string, current: string): Promise<void> {
  return notify(`update:${version}`, { kind: "updateAvailable", version, current }, "forever");
}

const RELEASE_CHECK_MS = 60 * 60_000;
let releaseCheckedAt = 0;

/**
 * The update check has no scheduler of its own (a page read refreshes it), so with nobody
 * looking no release would ever be noticed. Hourly, and only while it is wanted: the check's own
 * six-hour cache decides whether the registry is asked.
 */
export async function watchReleases(now: number): Promise<void> {
  if (now - releaseCheckedAt < RELEASE_CHECK_MS) return;
  releaseCheckedAt = now;
  const [{ eventKindDeliverable }, { getUpdateStatus }] = await Promise.all([
    import("./index"),
    import("../runtime/updates"),
  ]);
  if (!(await eventKindDeliverable("updateAvailable", "updateAvailable", now))) return;
  await getUpdateStatus();
}
