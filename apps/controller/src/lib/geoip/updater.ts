/**
 * Downloads a MaxMind edition only when missing or its build differs. The build is stored, not
 * read off the mtime, or a download landing the day of a second build would read as current.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { GEOIP_EDITIONS, type GeoipEdition } from "@cpm/shared";
import { geoipDatabasePath, geoipEnabled } from "../agent/geoip";
import { type StoredErrorCode, domainError, storedErrorCode } from "../errors/domain-error";
import { getSetting, setSetting } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";
import { checkGeoipUpdates, geoipCredentials } from "./update-check";

const DOWNLOAD_URL = "https://download.maxmind.com/geoip/databases";

/** How often to see whether a check is due; the interval itself is a setting. */
const WAKE_MS = 15 * 60 * 1000;

/** Generous: City is tens of megabytes over whatever link this host has. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Several times the largest archive; only stops an endless body exhausting memory. */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

const STATE_KEY = "geoip_downloads";

/** The mmdb format puts this before its metadata section, within the file's last 128 KiB. */
const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com", "ascii")]);
const METADATA_SEARCH_BYTES = 128 * 1024;

export type GeoipDownloadFailure = {
  edition: string;
  message: string;
  code: StoredErrorCode | null;
};

export type GeoipDownloadState = {
  /** Last run with GeoIP enabled and credentials set. */
  ranAt: string | null;
  /** Joined in English. */
  error: string | null;
  /** One by one, so a page can say them in its reader's language. */
  failures: GeoipDownloadFailure[];
  /** MaxMind build date (`YYYY-MM-DD`) of each file on disk. */
  builds: Partial<Record<GeoipEdition, string>>;
};

export type GeoipUpdateResult = {
  downloaded: GeoipEdition[];
  /** Every failure, the check's included, joined in English. */
  error: string | null;
  /** See `geoipUpdateErrorMessage`. */
  checkError?: { message: string; code: StoredErrorCode | null } | null;
  failures?: GeoipDownloadFailure[];
  /** Why nothing was attempted. */
  skipped?: "disabled" | "unconfigured";
};

export async function getGeoipDownloadState(): Promise<GeoipDownloadState> {
  const stored = await getSetting<GeoipDownloadState>(STATE_KEY);
  return {
    ranAt: stored?.ranAt ?? null,
    error: stored?.error ?? null,
    // Older stored states have only the joined English.
    failures: stored?.failures ?? [],
    builds: stored?.builds ?? {},
  };
}

/** Counted as it streams: Content-Length is the sender's claim and may be absent. */
export async function readCapped(
  response: Response,
  maxBytes = MAX_ARCHIVE_BYTES,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw domainError("geoipDownloadDeclaredTooLarge", { declared, max: maxBytes });
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw domainError("geoipDownloadTooLarge", { max: maxBytes });
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** `fetchImpl` lets the redirect and error handling be tested without the network. */
export async function fetchGeoipArchive(
  edition: GeoipEdition,
  accountId: string,
  licenseKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const url = `${DOWNLOAD_URL}/${edition}/download?suffix=tar.gz`;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  let response = await fetchImpl(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountId}:${licenseKey}`).toString("base64")}`,
    },
    redirect: "manual",
    signal,
  });

  // Presigned storage refuses a second credential, so Authorization must not follow the redirect.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw domainError("maxmindRedirectWithoutLocation");
    response = await fetchImpl(new URL(location, url).toString(), { signal });
  }

  if (response.status === 401) {
    throw domainError("maxmindCredentialsRejected");
  }
  if (!response.ok) {
    throw domainError("maxmindHttpStatus", { status: response.status });
  }
  return readCapped(response);
}

/** Cheaper than opening it, and enough to refuse an error page that arrived with a 200. */
export function looksLikeMmdb(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const from = Math.max(0, buffer.byteLength - METADATA_SEARCH_BYTES);
  return buffer.subarray(from).lastIndexOf(METADATA_MARKER) !== -1;
}

/** The build date comes from the archive's `<edition>_<YYYYMMDD>/` directory name. */
export async function extractGeoipDatabase(
  archive: Uint8Array,
  edition: GeoipEdition,
): Promise<{ bytes: Uint8Array; build: string | null }> {
  let files: Map<string, Blob>;
  try {
    files = await new Bun.Archive(archive).files("**/*.mmdb");
  } catch {
    throw domainError("geoipArchiveUnreadable");
  }

  for (const [path, file] of files) {
    if (basename(path) !== `${edition}.mmdb`) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikeMmdb(bytes)) throw domainError("geoipDatabaseInvalid", { edition });
    const date = /_(\d{4})(\d{2})(\d{2})\//.exec(path);
    return { bytes, build: date ? `${date[1]}-${date[2]}-${date[3]}` : null };
  }
  throw domainError("geoipDatabaseMissing", { edition });
}

/** Via rename: the agent route may be streaming the old file, and keeps reading what it opened. */
export function installGeoipDatabase(edition: GeoipEdition, bytes: Uint8Array): void {
  const target = geoipDatabasePath(edition);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(4).toString("hex")}.download`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

let inFlight: Promise<GeoipUpdateResult> | null = null;

/** Never throws: failures are stored, where the settings page reads them. */
export function updateGeoipDatabases(fetchImpl: typeof fetch = fetch): Promise<GeoipUpdateResult> {
  if (inFlight) return inFlight;
  inFlight = run(fetchImpl)
    .catch((error: unknown): GeoipUpdateResult => {
      console.error("[geoip] update failed:", error);
      return { downloaded: [], error: error instanceof Error ? error.message : String(error) };
    })
    .then(async (result) => {
      const { reportGeoipRun } = await import("../notifications/jobs");
      await reportGeoipRun(result);
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function run(fetchImpl: typeof fetch): Promise<GeoipUpdateResult> {
  if (!(await geoipEnabled())) return { downloaded: [], error: null, skipped: "disabled" };
  const { accountId, licenseKey } = await geoipCredentials();
  if (!accountId || !licenseKey) return { downloaded: [], error: null, skipped: "unconfigured" };

  const state = await getGeoipDownloadState();
  const builds = { ...state.builds };
  // Also the settings page's "last checked", so each tick keeps that current.
  const check = await checkGeoipUpdates(GEOIP_EDITIONS, fetchImpl);

  const downloaded: GeoipEdition[] = [];
  // Download failures only: the check stores its own.
  const failures: GeoipDownloadFailure[] = [];
  for (const edition of GEOIP_EDITIONS) {
    const available = check.available[edition];
    // With the check failed, an existing file is kept rather than spend MaxMind's daily limit.
    const current =
      existsSync(geoipDatabasePath(edition)) &&
      (available === undefined || builds[edition] === available);
    if (current) continue;

    // Sequential: parallel is no faster over one link and harder to read when it fails.
    try {
      const archive = await fetchGeoipArchive(edition, accountId, licenseKey, fetchImpl);
      const { bytes, build } = await extractGeoipDatabase(archive, edition);
      installGeoipDatabase(edition, bytes);
      const stamp = build ?? available;
      if (stamp) builds[edition] = stamp;
      else delete builds[edition];
      downloaded.push(edition);
      console.log(
        `[geoip] downloaded ${edition} (${bytes.byteLength} bytes, built ${stamp ?? "unknown"})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[geoip] could not download ${edition}: ${message}`);
      failures.push({ edition, message, code: storedErrorCode(error) });
    }
  }

  const stored =
    failures.length > 0
      ? failures.map((failure) => `${failure.edition}: ${failure.message}`).join("; ")
      : null;
  // A cache of what is on disk, not configuration, so it must not land in a staged change set.
  await outsideStagingScope(() =>
    setSetting<GeoipDownloadState>(STATE_KEY, {
      ranAt: new Date().toISOString(),
      error: stored,
      failures,
      builds,
    }),
  );

  if (downloaded.length > 0) {
    // Agents re-check the route on every push; the new ETag makes them download.
    const { pushFleetConfig } = await import("../agent/fleet-config");
    await pushFleetConfig();
  }
  const error = [check.error, stored].filter(Boolean).join("; ");
  return {
    downloaded,
    error: error || null,
    checkError: check.error ? { message: check.error, code: check.errorCode ?? null } : null,
    failures,
  };
}

/** From the stored run: a restart keeps the clock, and a new interval needs no reschedule. */
export function geoipUpdateDue(
  ranAt: string | null,
  intervalHours: number,
  now = Date.now(),
): boolean {
  if (!ranAt) return true;
  const last = Date.parse(ranAt);
  return !Number.isFinite(last) || now - last >= intervalHours * 60 * 60 * 1000;
}

async function updateIfDue(): Promise<void> {
  const [registry, { getSetting: resolve }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const [state, intervalHours] = await Promise.all([
    getGeoipDownloadState(),
    resolve(registry.geoipUpdateIntervalHours),
  ]);
  if (geoipUpdateDue(state.ranAt, intervalHours)) await updateGeoipDatabases();
}

let timer: NodeJS.Timeout | null = null;

/** Idempotent. */
export function startGeoipUpdater(): void {
  if (timer) return;
  const wake = () => {
    void updateIfDue().catch((error: unknown) => {
      console.error("[geoip] scheduled update failed:", error);
    });
  };
  wake();
  timer = setInterval(wake, WAKE_MS);
  timer.unref();
}
