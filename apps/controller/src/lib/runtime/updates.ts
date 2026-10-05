/**
 * Newer-image check against the registry's tag list, i.e. what can actually be pulled. The
 * repository is a setting because forks publish elsewhere. No scheduler: a read refreshes a stale
 * result in the background, so a page never waits on the network.
 */

import { APP_VERSION } from "./app-version";
import { type StoredErrorCode, domainError, storedErrorCode } from "../errors/domain-error";
import { getSetting, setSetting } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";

const CACHE_KEY = "update_check";

/** caddy and agent are released from the same tags, so checking one checks all three. */
const VERSIONED_IMAGE = "web";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 10_000;

/** Bounded so a repository with thousands of tags cannot walk pages indefinitely. */
const MAX_TAG_PAGES = 10;

type CachedCheck = {
  checkedAt: string;
  latest: string | null;
  error: string | null;
  /** Absent from results stored before codes existed. */
  errorCode?: StoredErrorCode | null;
  /** A changed repository setting makes the stored result irrelevant. */
  repository: string;
};

function recordFailure(result: CachedCheck, failure: Error): void {
  result.error = failure.message;
  result.errorCode = storedErrorCode(failure);
}

export type UpdateStatus = {
  enabled: boolean;
  /** "unknown" for a dev build with no APP_VERSION baked in. */
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
  /** For `storedErrorMessage` to say it in the reader's language. */
  errorCode: StoredErrorCode | null;
  repository: string;
};

// ── Version comparison ───────────────────────────────────────────────────────

type Semver = { major: number; minor: number; patch: number; prerelease: string[] };

/** All three numbers required, rejecting moving aliases (`latest`, `3`, `3.0`, `sha-...`). */
export function parseSemver(tag: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative when `a` is older. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // 3.0.0-beta.2 precedes 3.0.0; backwards, this announces the beta the operator just left.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    const result = comparePrereleaseIdentifier(a.prerelease[index], b.prerelease[index]);
    if (result !== 0) return result;
  }
  return a.prerelease.length - b.prerelease.length;
}

export function newestRelease(tags: string[]): string | null {
  let best: { tag: string; parsed: Semver } | null = null;
  for (const tag of tags) {
    const parsed = parseSemver(tag);
    if (!parsed) continue;
    if (!best || compareSemver(parsed, best.parsed) > 0) best = { tag, parsed };
  }
  return best?.tag ?? null;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const REPOSITORY = "ghcr.io/caddyproxymanager";
/** Where releases were published before; 3.6.1 stored the second as its default. */
const LEGACY_REPOSITORIES = [
  "ghcr.io/silentspud/caddy-proxy-manager",
  "ghcr.io/caddyproxymanager/caddy-proxy-manager",
];

/**
 * A deployed compose file sets the old namespace, outranking the default - left alone, those
 * installs would never hear of a release again.
 */
export function canonicalRepository(repository: string): string {
  const bare = repository
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return LEGACY_REPOSITORIES.includes(bare) ? REPOSITORY : repository;
}

/** Must look like a registry reference and is forced to https: the server fetches it. */
export function parseRepository(repository: string): { host: string; path: string } | null {
  const trimmed = repository
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!/^[a-z0-9][a-z0-9.-]*(:\d{1,5})?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+$/.test(trimmed)) {
    return null;
  }
  const separator = trimmed.indexOf("/");
  return { host: trimmed.slice(0, separator), path: trimmed.slice(separator + 1) };
}

/**
 * Refuses a link off the checked origin: an absolute `Link` would otherwise get the bearer token
 * sent anywhere. Throws rather than stopping, or half a tag list reads as "up to date".
 */
export function nextPageUrl(header: string | null, host: string): string | null {
  const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(header ?? "");
  if (!match) return null;

  const expected = new URL(`https://${host}/`);
  let next: URL;
  try {
    next = new URL(match[1], expected);
  } catch {
    throw domainError("registryPaginationNotUrl");
  }

  // Origin, not hostname: an http downgrade or port change is a different destination too.
  if (next.origin !== expected.origin) {
    throw domainError("registryPaginatedElsewhere", {
      origin: next.origin,
      expected: expected.origin,
    });
  }
  return next.toString();
}

const TOKEN_SERVICE_HOSTS: Record<string, readonly string[]> = {
  "docker.io": ["auth.docker.io"],
  "index.docker.io": ["auth.docker.io"],
  "registry-1.docker.io": ["auth.docker.io"],
  "registry.gitlab.com": ["gitlab.com"],
};

/** Same hazard as `nextPageUrl`: https, and the registry's origin or a known token service only. */
export function tokenRealmUrl(realm: string, host: string): URL {
  let url: URL;
  try {
    url = new URL(realm);
  } catch {
    throw domainError("registryRealmNotUrl");
  }

  const registry = new URL(`https://${host}/`);
  const knownService =
    url.port === "" && (TOKEN_SERVICE_HOSTS[registry.hostname] ?? []).includes(url.hostname);
  if (url.protocol !== "https:" || (url.host !== registry.host && !knownService)) {
    throw domainError("registryRealmElsewhere", { origin: url.origin, expected: registry.origin });
  }
  return url;
}

function parseChallenge(header: string): Record<string, string> | null {
  if (!/^bearer /i.test(header)) return null;
  const fields: Record<string, string> = {};
  for (const [, key, value] of header.slice(7).matchAll(/([a-z]+)="([^"]*)"/gi)) {
    fields[key.toLowerCase()] = value;
  }
  return fields.realm ? fields : null;
}

/** Follows the registry's auth challenge rather than hard-coding a token endpoint, for forks. */
async function listTags(host: string, repository: string, signal: AbortSignal): Promise<string[]> {
  let url: string | null = `https://${host}/v2/${repository}/tags/list?n=100`;
  let token: string | null = null;
  const tags: string[] = [];

  for (let page = 0; page < MAX_TAG_PAGES && url; page++) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;

    let response = await fetch(url, { headers, signal, redirect: "follow" });

    if (response.status === 401 && !token) {
      const challenge = parseChallenge(response.headers.get("www-authenticate") ?? "");
      if (!challenge) throw domainError("registryCredentialsRequired");

      const tokenUrl = tokenRealmUrl(challenge.realm, host);
      if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
      tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${repository}:pull`);

      const tokenResponse = await fetch(tokenUrl, {
        headers: { accept: "application/json" },
        signal,
        // A redirect would carry the request past the check above.
        redirect: "error",
      });
      if (!tokenResponse.ok) {
        throw domainError("registryTokenRefused", { status: tokenResponse.status });
      }
      const issued = (await tokenResponse.json()) as { token?: string; access_token?: string };
      token = issued.token ?? issued.access_token ?? null;
      if (!token) throw domainError("registryNoToken");

      response = await fetch(url, {
        headers: { ...headers, authorization: `Bearer ${token}` },
        signal,
      });
    }

    if (response.status === 404) throw domainError("registryRepositoryNotFound");
    if (!response.ok) throw domainError("registryHttpStatus", { status: response.status });

    const body = (await response.json()) as { tags?: string[] | null };
    if (Array.isArray(body.tags)) tags.push(...body.tags);

    url = nextPageUrl(response.headers.get("link"), host);
  }

  return tags;
}

// ── Checking ─────────────────────────────────────────────────────────────────

async function settings(): Promise<{ enabled: boolean; repository: string }> {
  const [registry, { getSetting: resolve }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const [enabled, repository] = await Promise.all([
    resolve(registry.updateCheckEnabled),
    resolve(registry.updateImageRepository),
  ]);
  return { enabled, repository: canonicalRepository(repository) };
}

/** Several readers finding the cache stale at once ask only once. */
let inFlight: Promise<CachedCheck> | null = null;

/** Failures are cached too: retried on schedule, not per page load, and shown with their reason. */
export async function checkForUpdates(): Promise<CachedCheck> {
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<CachedCheck> => {
    const { repository } = await settings();
    const result: CachedCheck = {
      checkedAt: new Date().toISOString(),
      latest: null,
      error: null,
      errorCode: null,
      repository,
    };

    const parsed = parseRepository(repository);
    if (!parsed) {
      recordFailure(result, domainError("updateRepositoryInvalid", { repository }));
    } else {
      try {
        const tags = await listTags(
          parsed.host,
          `${parsed.path}/${VERSIONED_IMAGE}`,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        );
        result.latest = newestRelease(tags);
        if (!result.latest) recordFailure(result, domainError("updateNoReleases"));
        else if (isNewer(APP_VERSION, result.latest)) {
          // Imported here: the notifications reach the settings, and this module is read by pages.
          const { reportReleaseAvailable } = await import("../notifications/jobs");
          await reportReleaseAvailable(result.latest, APP_VERSION);
        }
      } catch (error) {
        recordFailure(
          result,
          error instanceof Error && error.name === "TimeoutError"
            ? domainError("updateTimedOut")
            : error instanceof Error
              ? error
              : domainError("checkFailed"),
        );
      }
    }

    // A cache: the check Settings runs on save must not land in the operator's staged change set.
    await outsideStagingScope(() => setSetting<CachedCheck>(CACHE_KEY, result));
    return result;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Never awaits the network: a stale answer is refreshed for the next render. */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const { enabled, repository } = await settings();

  // Hide the cached answer while off (it may be months stale and "Check now" is disabled), but
  // keep the row so re-enabling shows it at once.
  if (!enabled) {
    return {
      enabled: false,
      current: APP_VERSION,
      latest: null,
      updateAvailable: false,
      checkedAt: null,
      error: null,
      errorCode: null,
      repository,
    };
  }

  const cached = await getSetting<CachedCheck>(CACHE_KEY);

  const status: UpdateStatus = {
    enabled,
    current: APP_VERSION,
    latest: cached?.repository === repository ? (cached.latest ?? null) : null,
    updateAvailable: false,
    checkedAt: cached?.repository === repository ? cached.checkedAt : null,
    error: cached?.repository === repository ? (cached.error ?? null) : null,
    errorCode: cached?.repository === repository ? (cached.errorCode ?? null) : null,
    repository,
  };

  const age = status.checkedAt
    ? Date.now() - Date.parse(status.checkedAt)
    : Number.POSITIVE_INFINITY;
  if (age > CACHE_TTL_MS) {
    // For the next render; swallowed so a dead registry is no unhandled rejection.
    void checkForUpdates().catch(() => {});
  }

  status.updateAvailable = isNewer(status.current, status.latest);
  return status;
}

/** False when the comparison cannot be made: a wrong "yes" sends an operator chasing nothing. */
export function isNewer(current: string, latest: string | null): boolean {
  if (!latest) return false;
  const a = parseSemver(current);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  return compareSemver(b, a) > 0;
}
