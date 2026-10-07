/**
 * Refreshes the CRS plugin registries and a verdict per plugin on a timer, so no page waits on
 * GitHub. Verdicts are keyed by release, so after the first pass only changed releases are fetched,
 * inside the 60-an-hour limit; a pass cut short resumes on the next.
 */

import { DomainError, type StoredErrorCode, storedErrorCode } from "../../errors/domain-error";
import { outboundAllowed } from "../../offline";
import { getSetting, setSetting } from "../../settings";
import { outsideStagingScope } from "../../settings/staging-context";
import {
  type CrsPluginSupport,
  type CrsRegistryEntry,
  type CrsUnsupportedReason,
  type Fetcher,
  checkCrsPluginSupport,
  fetchCrsRegistry,
  resolveCrsPluginVersion,
  withGitHubToken,
} from "./registry";
import { crsRegistryGithubToken, getCrsRegistrySettings } from "./settings";

const STATE_KEY = "crs_plugin_registry_state";

/** How often the timer wakes to see whether a pass is due. The interval itself is a setting. */
const WAKE_MS = 15 * 60 * 1000;

type StoredFailure = { message: string; code: StoredErrorCode | null };

/** A registry entry, and which configured registry listed it. */
export type CrsListedPlugin = CrsRegistryEntry & { registryId: string };

export type CrsPluginVerdict = {
  repository: string;
  version: string;
  supported: boolean;
  reason: CrsUnsupportedReason | null;
  /** The English refusal, for the API; `code` renders it for a reader. */
  message: string | null;
  code: StoredErrorCode | null;
  checkedAt: string;
};

export type CrsRegistryState = {
  /** When the last pass over every plugin finished, or null if none has. */
  checkedAt: string | null;
  /** Why the last pass stopped short, if it did. */
  error: StoredFailure | null;
  entries: CrsListedPlugin[];
  /** By registry id: the URL read, when, and why it last failed. */
  sources: Record<string, { url: string; fetchedAt: string | null; error: StoredFailure | null }>;
  /** By `verdictKey`. */
  verdicts: Record<string, CrsPluginVerdict>;
  /** Latest release by repository, for installed plugins' update badges. */
  latestVersions: Record<string, string>;
};

const EMPTY_STATE: CrsRegistryState = {
  checkedAt: null,
  error: null,
  entries: [],
  sources: {},
  verdicts: {},
  latestVersions: {},
};

/** Two registries may list the same name for different plugins. */
export function verdictKey(plugin: Pick<CrsListedPlugin, "registryId" | "name">): string {
  return `${plugin.registryId}/${plugin.name}`;
}

export async function getCrsRegistryState(): Promise<CrsRegistryState> {
  const stored = await outsideStagingScope(() => getSetting<Partial<CrsRegistryState>>(STATE_KEY));
  return { ...EMPTY_STATE, ...stored };
}

async function saveState(state: CrsRegistryState): Promise<void> {
  await outsideStagingScope(() => setSetting(STATE_KEY, state));
}

function failure(error: unknown): StoredFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: storedErrorCode(error),
  };
}

/** True when the stored lists do not match the configured registries. */
export async function crsRegistryListsStale(): Promise<boolean> {
  const [{ registries }, state] = await Promise.all([
    getCrsRegistrySettings(),
    getCrsRegistryState(),
  ]);
  return (
    registries.length !== Object.keys(state.sources).length ||
    registries.some((source) => state.sources[source.id]?.url !== source.url)
  );
}

/**
 * Re-reads every registry's list alone - no GitHub API calls - so a page can show a new or changed
 * registry at once. A registry that fails keeps the entries it had, if its URL is unchanged.
 */
export async function refreshCrsRegistryLists(fetcher: Fetcher = fetch): Promise<CrsRegistryState> {
  const [{ registries }, previous] = await Promise.all([
    getCrsRegistrySettings(),
    getCrsRegistryState(),
  ]);
  const entries: CrsListedPlugin[] = [];
  const sources: CrsRegistryState["sources"] = {};
  for (const source of registries) {
    const before = previous.sources[source.id];
    const sameUrl = before?.url === source.url;
    try {
      const listed = await fetchCrsRegistry(fetcher, source.url);
      entries.push(...listed.map((entry) => ({ ...entry, registryId: source.id })));
      sources[source.id] = { url: source.url, fetchedAt: new Date().toISOString(), error: null };
    } catch (error) {
      if (sameUrl) {
        entries.push(...previous.entries.filter((entry) => entry.registryId === source.id));
      }
      sources[source.id] = {
        url: source.url,
        fetchedAt: sameUrl ? (before?.fetchedAt ?? null) : null,
        error: failure(error),
      };
    }
  }
  const keep = new Set(entries.map(verdictKey));
  const verdicts = Object.fromEntries(
    Object.entries(previous.verdicts).filter(([key]) => keep.has(key)),
  );
  const state: CrsRegistryState = { ...previous, entries, sources, verdicts };
  await saveState(state);
  return state;
}

export type CrsSyncOptions = {
  fetcher?: Fetcher;
  /** Installed plugins' repositories, which may be in no configured registry any more. */
  extraRepositories?: readonly string[];
};

let running: Promise<CrsRegistryState> | null = null;

/** One pass. Concurrent callers share the pass already running rather than starting another. */
export function runCrsRegistrySync(options: CrsSyncOptions = {}): Promise<CrsRegistryState> {
  running ??= syncOnce(options).finally(() => {
    running = null;
  });
  return running;
}

async function syncOnce({
  fetcher = fetch,
  extraRepositories = [],
}: CrsSyncOptions): Promise<CrsRegistryState> {
  let state = await refreshCrsRegistryLists(fetcher);
  const github = withGitHubToken(fetcher, await crsRegistryGithubToken());
  const verdicts = { ...state.verdicts };
  const latestVersions = { ...state.latestVersions };
  // Within one pass: two registries listing the same repository cost one lookup.
  const resolved = new Map<string, string>();
  const checked = new Map<string, CrsPluginSupport>();
  const latest = async (repository: string) => {
    let version = resolved.get(repository);
    if (version === undefined) {
      version = await resolveCrsPluginVersion({ repository }, github);
      resolved.set(repository, version);
      latestVersions[repository] = version;
    }
    return version;
  };

  try {
    for (const entry of state.entries) {
      const version = await latest(entry.repository);
      const key = verdictKey(entry);
      const previous = verdicts[key];
      if (previous?.repository === entry.repository && previous.version === version) continue;
      // The range is part of the check, so it is part of what makes two checks the same.
      const checkKey = `${entry.repository}@${version}#${entry.ruleIdStart}-${entry.ruleIdEnd}`;
      let support = checked.get(checkKey);
      if (!support) {
        support = await checkCrsPluginSupport(entry, version, github);
        checked.set(checkKey, support);
      }
      verdicts[key] = {
        repository: entry.repository,
        version,
        supported: support.supported,
        reason: support.supported ? null : support.reason,
        message: support.supported ? null : support.error.message,
        code: support.supported ? null : storedErrorCode(support.error),
        checkedAt: new Date().toISOString(),
      };
      // Saved as it goes, so a pass cut short by the rate limit keeps what it finished.
      await saveState({ ...state, verdicts, latestVersions });
    }
    for (const repository of extraRepositories) await latest(repository);
  } catch (error) {
    if (!(error instanceof DomainError)) {
      console.error("[crs-plugins] registry check failed:", error);
    }
    state = { ...state, verdicts, latestVersions, error: failure(error) };
    await saveState(state);
    return state;
  }

  state = { ...state, verdicts, latestVersions, error: null, checkedAt: new Date().toISOString() };
  await saveState(state);
  return state;
}

/** Runs a pass when the interval has passed since the last complete one. */
export async function syncCrsRegistryIfDue(options: CrsSyncOptions = {}): Promise<boolean> {
  const { refreshIntervalHours } = await getCrsRegistrySettings();
  if (refreshIntervalHours === 0 || !(await outboundAllowed("crsRegistry"))) return false;
  const state = await getCrsRegistryState();
  const last =
    state.checkedAt && !(await crsRegistryListsStale()) ? Date.parse(state.checkedAt) : 0;
  if (Date.now() - last < refreshIntervalHours * 60 * 60 * 1000) return false;
  await runCrsRegistrySync(options);
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** `extraRepositories` is read on every wake, so a plugin installed since is included. */
export function startCrsRegistryUpdater(extraRepositories: () => Promise<readonly string[]>): void {
  if (timer) return;
  const wake = () => {
    void extraRepositories()
      .then((repositories) => syncCrsRegistryIfDue({ extraRepositories: repositories }))
      .catch((error: unknown) => {
        console.error("[crs-plugins] scheduled registry check failed:", error);
      });
  };
  wake();
  timer = setInterval(wake, WAKE_MS);
  timer.unref();
}

/** On losing the lead (lib/cluster); a pass already running finishes. */
export function stopCrsRegistryUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
