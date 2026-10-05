/**
 * The OWASP CRS plugin registry, and fetching a plugin's rule files at its latest release tag (or
 * default-branch commit) so the install is recorded exactly. Files go into the database and are
 * inlined into WAF directives, since Caddy on the agents' hosts has only the embedded CRS tree.
 */

import { findCrsPluginRejections } from "../caddy";
import { DomainError, domainError, domainErrorMessage } from "../../errors/domain-error";

/** The OWASP registry; an operator may point at a registry of their own instead. */
export const OFFICIAL_CRS_REGISTRY_URL =
  "https://raw.githubusercontent.com/coreruleset/plugin-registry/main/registry.json";
const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

const FETCH_TIMEOUT_MS = 15_000;

/** The largest registered plugin is under 100 KiB; this only stops an endless body. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)\/?$/;
const PLUGIN_FILE = /^[A-Za-z0-9._-]+-(config|before|after)\.conf$/;
/** A tag or commit as it goes into a URL path. GitHub allows more; nothing registered uses it. */
const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type CrsRegistryEntry = {
  name: string;
  repository: string;
  type: "official" | "3rd-party";
  status: "tested" | "being-tested" | "untested" | "draft";
  license: string;
  ruleIdStart: number;
  ruleIdEnd: number;
};

/**
 * Why a registry plugin cannot be installed here, found by fetching and checking its latest
 * release (`checkCrsPluginSupport`). Static checks only: whether Coraza actually compiles a
 * plugin is not tested yet.
 */
export type CrsUnsupportedReason =
  | "files"
  | "engine"
  | "compile"
  | "ruleIds"
  | "noRules"
  | "directives";

export type CrsPluginRelease = {
  version: string;
  description: string | null;
  /** The plugins/ rule files the release shipped, sorted. */
  fileNames: string[];
  configRules: string;
  beforeRules: string;
  afterRules: string;
};

const TYPES = new Set(["official", "3rd-party"]);
const STATUSES = new Set(["tested", "being-tested", "untested", "draft"]);

/** Drops what cannot be installed or does not parse, rather than failing the whole listing. */
export function parseCrsRegistry(json: unknown): CrsRegistryEntry[] {
  const plugins = (json as { plugins?: unknown })?.plugins;
  if (!Array.isArray(plugins)) return [];
  const entries: CrsRegistryEntry[] = [];
  for (const raw of plugins) {
    const p = raw as Record<string, unknown>;
    const range = p?.rule_id_range as { start?: unknown; end?: unknown } | undefined;
    if (
      typeof p?.name !== "string" ||
      typeof p.repository !== "string" ||
      !REPOSITORY.test(p.repository) ||
      !TYPES.has(p.type as string) ||
      !STATUSES.has(p.status as string) ||
      !Number.isInteger(range?.start) ||
      !Number.isInteger(range?.end) ||
      // A private repository answers 404 to everyone outside it.
      p.private === true
    ) {
      continue;
    }
    entries.push({
      name: p.name,
      repository: p.repository.replace(/\/$/, ""),
      type: p.type as CrsRegistryEntry["type"],
      status: p.status as CrsRegistryEntry["status"],
      license: typeof p.license === "string" ? p.license : "",
      ruleIdStart: range!.start as number,
      ruleIdEnd: range!.end as number,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** By parsed host: a prefix test would pass `https://api.github.com.example.test/`. */
function isGitHubApi(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === "api.github.com";
  } catch {
    return false;
  }
}

/** Adds the GitHub token (60 requests an hour becomes 5,000); sent to api.github.com only. */
export function withGitHubToken(fetcher: Fetcher, token: string | null): Fetcher {
  if (!token) return fetcher;
  return (input, init) =>
    fetcher(
      input,
      isGitHubApi(input)
        ? {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string>),
              Authorization: `Bearer ${token}`,
            },
          }
        : init,
    );
}

async function get(fetcher: Fetcher, url: string, accept?: string): Promise<Response> {
  try {
    return await fetcher(url, {
      headers: {
        "User-Agent": "caddy-proxy-manager",
        ...(isGitHubApi(url)
          ? {
              Accept: accept ?? "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            }
          : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (error) {
    throw domainError(
      "crsPluginFetchFailed",
      { url, reason: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

function failed(url: string, response: Response): never {
  // Unauthenticated, the GitHub API allows 60 requests an hour per address.
  if (response.status === 403 || response.status === 429) {
    throw domainError("crsPluginRateLimited", {}, { status: 400 });
  }
  throw domainError(
    "crsPluginFetchFailed",
    { url, reason: `HTTP ${response.status}` },
    { status: 400 },
  );
}

/**
 * Counted as it streams, since Content-Length is the sender's claim and may be absent: a registry
 * is any URL an admin adds, so an endless body must not reach memory whole.
 */
async function readText(url: string, response: Response): Promise<string> {
  const tooLarge = () =>
    domainError("crsPluginFetchFailed", { url, reason: "too large" }, { status: 400 });
  if (Number(response.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).replace(/\r\n?/g, "\n");
}

/** Reads a registry.json. Callers keep the result; see crs-plugins/sync.ts. */
export async function fetchCrsRegistry(
  fetcher: Fetcher = fetch,
  url: string = OFFICIAL_CRS_REGISTRY_URL,
): Promise<CrsRegistryEntry[]> {
  const response = await get(fetcher, url);
  if (!response.ok) failed(url, response);
  const text = await readText(url, response);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw domainError("crsPluginFetchFailed", { url, reason: "not JSON" }, { status: 400 });
  }
  return parseCrsRegistry(json);
}

function repoPath(entry: Pick<CrsRegistryEntry, "repository">): string {
  const match = REPOSITORY.exec(entry.repository);
  if (!match) throw domainError("crsPluginNotInRegistry", {}, { status: 400 });
  return `${match[1]}/${match[2]}`;
}

/** The latest release tag, or the default branch's commit for a plugin that never tagged one. */
export async function resolveCrsPluginVersion(
  entry: Pick<CrsRegistryEntry, "repository">,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const repo = repoPath(entry);
  const releaseUrl = `${GITHUB_API}/repos/${repo}/releases/latest`;
  const release = await get(fetcher, releaseUrl);
  let ref: unknown;
  if (release.ok) {
    ref = ((await release.json()) as { tag_name?: unknown }).tag_name;
  } else if (release.status === 404) {
    const commitUrl = `${GITHUB_API}/repos/${repo}/commits/HEAD`;
    const commit = await get(fetcher, commitUrl);
    if (!commit.ok) failed(commitUrl, commit);
    ref = ((await commit.json()) as { sha?: unknown }).sha;
  } else {
    failed(releaseUrl, release);
  }
  if (typeof ref !== "string" || !SAFE_REF.test(ref) || ref.includes("..")) {
    throw domainError(
      "crsPluginFetchFailed",
      { url: releaseUrl, reason: "no usable release" },
      { status: 400 },
    );
  }
  return ref;
}

function rawUrl(repo: string, ref: string, path: string): string {
  const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_RAW}/${repo}/${encodedRef}/${path}`;
}

/** The plugin.yaml fields CPM reads. The descriptor is newer than most releases, so it is optional. */
async function fetchDescriptor(
  fetcher: Fetcher,
  repo: string,
  ref: string,
): Promise<{ description: string | null; engines: string[] | null }> {
  const url = rawUrl(repo, ref, "plugin.yaml");
  const response = await get(fetcher, url);
  if (!response.ok) return { description: null, engines: null };
  try {
    const doc = Bun.YAML.parse(await readText(url, response)) as {
      plugin?: { description?: unknown };
      compatibility?: { engines?: unknown };
    };
    const description = doc?.plugin?.description;
    const engines = doc?.compatibility?.engines;
    return {
      description:
        typeof description === "string" && description.trim() ? description.trim() : null,
      engines: Array.isArray(engines)
        ? engines.filter((e): e is string => typeof e === "string")
        : null,
    };
  } catch {
    return { description: null, engines: null };
  }
}

/** What a release is fetched and checked by; a registry entry, or an installed plugin. */
export type CrsPluginSource = Pick<CrsRegistryEntry, "repository" | "ruleIdStart" | "ruleIdEnd">;

/** Throws, naming each refused line, rather than returning a plugin that would be half emitted. */
export async function fetchCrsPluginRelease(
  entry: CrsPluginSource,
  version: string,
  fetcher: Fetcher = fetch,
): Promise<CrsPluginRelease> {
  const repo = repoPath(entry);
  const listUrl = `${GITHUB_API}/repos/${repo}/contents/plugins?ref=${encodeURIComponent(version)}`;
  const listing = await get(fetcher, listUrl);
  if (listing.status === 404) throw domainError("crsPluginNoRuleFiles", {}, { status: 400 });
  if (!listing.ok) failed(listUrl, listing);
  const files = ((await listing.json()) as { name?: unknown; type?: unknown }[])
    .filter((f) => f?.type === "file" && typeof f.name === "string" && PLUGIN_FILE.test(f.name))
    .map((f) => f.name as string)
    .sort();
  if (files.length === 0) throw domainError("crsPluginNoRuleFiles", {}, { status: 400 });

  const descriptor = await fetchDescriptor(fetcher, repo, version);
  if (
    descriptor.engines &&
    descriptor.engines.length > 0 &&
    !descriptor.engines.includes("coraza") &&
    !descriptor.engines.includes("all")
  ) {
    throw domainError(
      "crsPluginEngineIncompatible",
      { engines: descriptor.engines },
      { status: 400 },
    );
  }

  const rules = { config: [] as string[], before: [] as string[], after: [] as string[] };
  for (const name of files) {
    // Built from the repository rather than taken from the listing's download_url, so a listing
    // can only ever point back into the same repository.
    const url = rawUrl(repo, version, `plugins/${encodeURIComponent(name)}`);
    const response = await get(fetcher, url);
    if (!response.ok) failed(url, response);
    rules[PLUGIN_FILE.exec(name)![1] as keyof typeof rules].push(
      (await readText(url, response)).trim(),
    );
  }

  const release: CrsPluginRelease = {
    version,
    description: descriptor.description,
    fileNames: files,
    configRules: rules.config.join("\n"),
    beforeRules: rules.before.join("\n"),
    afterRules: rules.after.join("\n"),
  };
  assertCrsPluginRulesLoadable(
    [release.configRules, release.beforeRules, release.afterRules],
    entry.ruleIdStart,
    entry.ruleIdEnd,
  );
  return release;
}

/** At most this many refused lines are named; a plugin built around Lua would list dozens. */
const MAX_NAMED_REJECTIONS = 3;

export function assertCrsPluginRulesLoadable(
  files: readonly string[],
  ruleIdStart: number,
  ruleIdEnd: number,
): void {
  const rejections = files.flatMap((text) =>
    findCrsPluginRejections(text, { start: ruleIdStart, end: ruleIdEnd }),
  );
  if (rejections.length === 0) return;
  const range = { start: String(ruleIdStart), end: String(ruleIdEnd) };
  const details = rejections
    .slice(0, MAX_NAMED_REJECTIONS)
    .map(
      (entry) =>
        `"${entry.line.slice(0, 160)}" - ${domainErrorMessage(entry.reason, { ...range, ...entry.params })}`,
    );
  throw domainError(
    "crsPluginRejected",
    // `reasons` is for checkCrsPluginSupport; the message does not print it.
    { count: rejections.length, details, reasons: [...new Set(rejections.map((r) => r.reason))] },
    { status: 400 },
  );
}

/** Which rejection explains a plugin best when it has several: the most fundamental first. */
const REJECTION_REASON: [string, CrsUnsupportedReason][] = [
  ["crsPluginNeedsFile", "files"],
  ["crsPluginPersistentCollection", "compile"],
  ["crsPluginUnbalancedQuotes", "compile"],
  ["crsPluginUnterminated", "compile"],
  ["crsPluginInvalidSeclang", "compile"],
  ["crsPluginRuleIdOutOfRange", "ruleIds"],
  ["crsPluginDirectiveNotAllowed", "directives"],
  ["crsPluginCtlRuleEngine", "directives"],
];

export type CrsPluginSupport =
  | { supported: true }
  | { supported: false; reason: CrsUnsupportedReason; error: DomainError };

/**
 * Fetches `version` and runs the same checks an install does, returning a verdict instead of
 * throwing. A failure to fetch at all - a rate limit, GitHub being down - is not a verdict about
 * the plugin, so that still throws.
 */
export async function checkCrsPluginSupport(
  entry: CrsPluginSource,
  version: string,
  fetcher: Fetcher = fetch,
): Promise<CrsPluginSupport> {
  try {
    await fetchCrsPluginRelease(entry, version, fetcher);
    return { supported: true };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (error.code === "crsPluginEngineIncompatible") {
      return { supported: false, reason: "engine", error };
    }
    if (error.code === "crsPluginNoRuleFiles")
      return { supported: false, reason: "noRules", error };
    if (error.code === "crsPluginRejected") {
      const found = new Set(error.params.reasons as readonly string[]);
      const reason = REJECTION_REASON.find(([code]) => found.has(code))?.[1] ?? "directives";
      return { supported: false, reason, error };
    }
    throw error;
  }
}
