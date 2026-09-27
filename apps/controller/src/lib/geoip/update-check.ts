/**
 * Stores when MaxMind was asked, so "nothing new" is distinguishable from "the updater is failing".
 * A read refreshes a stale answer behind the caller, as ../updates.ts does; failures are cached too
 * so an unreachable endpoint is not retried on every render.
 */

import { type StoredErrorCode, domainError, storedErrorCode } from "../domain-error";
import { getSetting, setSetting } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";

const CACHE_KEY = "geoip_update_check";

/** Build date and checksum without the download: a check costs bytes, not megabytes. */
const METADATA_URL = "https://updates.maxmind.com/geoip/updates/metadata";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** MaxMind must not hold a page open; the cached answer is served regardless. */
const REQUEST_TIMEOUT_MS = 10_000;

export type GeoipUpdateCheck = {
  checkedAt: string;
  error: string | null;
  /** Absent from results stored before codes were. */
  errorCode?: StoredErrorCode | null;
  /** Edition id to its last build date, `YYYY-MM-DD`. */
  available: Record<string, string>;
};

export type GeoipUpdateCheckStatus = {
  checkedAt: string | null;
  error: string | null;
  errorCode: StoredErrorCode | null;
  available: Record<string, string>;
};

type MetadataResponse = {
  databases?: { edition_id?: unknown; date?: unknown }[] | null;
};

export async function geoipCredentials(): Promise<{ accountId: string; licenseKey: string }> {
  const [registry, { getSetting: resolve }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const [accountId, licenseKey] = await Promise.all([
    resolve(registry.geoipAccountId),
    resolve(registry.geoipLicenseKey),
  ]);
  return { accountId: accountId.trim(), licenseKey: licenseKey.trim() };
}

/** `fetchImpl` is a test seam; production callers never pass it. */
export async function fetchGeoipMetadata(
  editions: readonly string[],
  accountId: string,
  licenseKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  if (editions.length === 0) return {};

  const url = new URL(METADATA_URL);
  for (const edition of editions) url.searchParams.append("edition_id", edition);

  const response = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountId}:${licenseKey}`).toString("base64")}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401) {
    throw domainError("maxmindCredentialsRejected");
  }
  if (!response.ok) {
    throw domainError("maxmindHttpStatus", { status: response.status });
  }

  const body = (await response.json()) as MetadataResponse;
  const available: Record<string, string> = {};
  for (const database of body.databases ?? []) {
    // A third party's shape: skip an odd row rather than lose the others.
    if (typeof database?.edition_id === "string" && typeof database?.date === "string") {
      available[database.edition_id] = database.date;
    }
  }
  return available;
}

/** Several readers finding the answer stale ask MaxMind once. */
let inFlight: Promise<GeoipUpdateCheck> | null = null;

/** Stores the result either way. Exported for the settings "check now" button. */
export async function checkGeoipUpdates(
  editions: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<GeoipUpdateCheck> {
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<GeoipUpdateCheck> => {
    const result: GeoipUpdateCheck = {
      checkedAt: new Date().toISOString(),
      error: null,
      errorCode: null,
      available: {},
    };
    const recordFailure = (failure: Error) => {
      result.error = failure.message;
      result.errorCode = storedErrorCode(failure);
    };

    const { accountId, licenseKey } = await geoipCredentials();
    if (!accountId || !licenseKey) {
      recordFailure(domainError("maxmindCredentialsMissing"));
    } else {
      try {
        result.available = await fetchGeoipMetadata(editions, accountId, licenseKey, fetchImpl);
      } catch (error) {
        recordFailure(
          error instanceof Error && error.name === "TimeoutError"
            ? domainError("maxmindTimedOut")
            : error instanceof Error
              ? error
              : domainError("checkFailed"),
        );
      }
    }

    // A cache, so a refresh a settings page triggered must not land in a staged change set.
    await outsideStagingScope(() => setSetting<GeoipUpdateCheck>(CACHE_KEY, result));
    return result;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Never awaits the network: the first render after enabling GeoIP reports no check yet. */
export async function getGeoipUpdateCheck(
  editions: readonly string[],
  ttlMs = DEFAULT_TTL_MS,
): Promise<GeoipUpdateCheckStatus> {
  const cached = await getSetting<GeoipUpdateCheck>(CACHE_KEY);

  const age = cached ? Date.now() - Date.parse(cached.checkedAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(age) || age > ttlMs) {
    // The failure is stored already; an unhandled rejection would take down the render.
    void checkGeoipUpdates(editions).catch(() => {});
  }

  return {
    checkedAt: cached?.checkedAt ?? null,
    error: cached?.error ?? null,
    errorCode: cached?.errorCode ?? null,
    available: cached?.available ?? {},
  };
}

/** Coarse on purpose: to the day, which is the resolution MaxMind publishes. */
export function editionsBehind(
  available: Record<string, string>,
  installed: { edition: string; updatedAt: Date }[],
): string[] {
  const behind: string[] = [];
  for (const database of installed) {
    const built = available[database.edition];
    if (!built) continue;
    const builtAt = Date.parse(`${built}T00:00:00Z`);
    if (!Number.isFinite(builtAt)) continue;

    // So a database downloaded the day it was built never reads as behind.
    const writtenDay = Date.parse(`${database.updatedAt.toISOString().slice(0, 10)}T00:00:00Z`);
    if (builtAt > writtenDay) behind.push(database.edition);
  }
  return behind;
}
