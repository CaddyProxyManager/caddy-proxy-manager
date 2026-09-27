import db, { nowIso, toIso } from "../db";
import { applyCaddyConfig } from "../caddy";
import { logAuditEvent } from "../audit";
import { crsPlugins, proxyHosts } from "../db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { domainError } from "../domain-error";
import { type CrsPluginRules, findCrsPluginRejections, normalizeWafPluginIds } from "../caddy-waf";
import {
  type CrsUnsupportedReason,
  type Fetcher,
  assertCrsPluginRulesLoadable,
  fetchCrsPluginRelease,
  resolveCrsPluginVersion,
  withGitHubToken,
} from "../crs-plugins/registry";
import { crsRegistryGithubToken, getCrsRegistrySettings } from "../crs-plugins/settings";
import {
  type CrsListedPlugin,
  crsRegistryListsStale,
  getCrsRegistryState,
  refreshCrsRegistryLists,
  verdictKey,
} from "../crs-plugins/sync";
import { getDashboardSettings, getWafSettings } from "../settings";
import { assertWafLoads, wafCandidatesSelecting } from "../waf-dry-run";
import {
  type CrsPluginLoadFailure,
  getCrsPluginQuarantine,
  releaseCrsPlugin,
} from "../crs-plugins/quarantine";

// ── Types ────────────────────────────────────────────────────────────

export type CrsPlugin = {
  id: number;
  name: string;
  repository: string;
  version: string;
  description: string | null;
  ruleIdStart: number;
  ruleIdEnd: number;
  configRules: string;
  beforeRules: string;
  afterRules: string;
  /** The operator's -config file, or null while the upstream one runs. */
  configOverride: string | null;
  /** The plugins/ rule files the installed release shipped. */
  fileNames: string[];
  createdAt: string;
  updatedAt: string;
};

/** Where a plugin is selected, shaped like a preset's. */
export type CrsPluginUsage = {
  global: boolean;
  dashboard: boolean;
  hosts: { id: number; name: string }[];
};

type PluginRow = typeof crsPlugins.$inferSelect;

function parseFileNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function toCrsPlugin(row: PluginRow): CrsPlugin {
  return {
    id: row.id,
    name: row.name,
    repository: row.repository,
    version: row.version,
    description: row.description,
    ruleIdStart: row.ruleIdStart,
    ruleIdEnd: row.ruleIdEnd,
    configRules: row.configRules,
    beforeRules: row.beforeRules,
    afterRules: row.afterRules,
    configOverride: row.configOverride,
    fileNames: parseFileNames(row.fileNames),
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

export function toCrsPluginOption(plugin: CrsPlugin): {
  id: number;
  name: string;
  description: string | null;
} {
  return { id: plugin.id, name: plugin.name, description: plugin.description };
}

// ── Reads ────────────────────────────────────────────────────────────

export async function listCrsPlugins(): Promise<CrsPlugin[]> {
  const rows = await db.query.crsPlugins.findMany({ orderBy: (table) => asc(table.name) });
  return rows.map(toCrsPlugin);
}

export async function getCrsPlugin(id: number): Promise<CrsPlugin | null> {
  const row = await db.query.crsPlugins.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  return row ? toCrsPlugin(row) : null;
}

/**
 * id -> rule files, for the Caddy builder. Every write is checked already; a row that fails anyway
 * is left out whole, since half a plugin can leave its exclusions on with its guards gone.
 */
export async function getCrsPluginRules(): Promise<Map<number, CrsPluginRules>> {
  const rules = new Map<number, CrsPluginRules>();
  // Left out like an uninstalled plugin: a host still selecting it loads the rest of its WAF.
  const quarantine = await getCrsPluginQuarantine();
  for (const row of await db.select().from(crsPlugins)) {
    if (row.id in quarantine) continue;
    const plugin: CrsPluginRules = {
      config: row.configOverride ?? row.configRules,
      before: row.beforeRules,
      after: row.afterRules,
    };
    const range = { start: row.ruleIdStart, end: row.ruleIdEnd };
    const loadable = Object.values(plugin).every(
      (text) => findCrsPluginRejections(text, range).length === 0,
    );
    if (loadable) rules.set(row.id, plugin);
  }
  return rules;
}

function pluginIdsInMeta(meta: string | null): number[] {
  if (!meta) return [];
  try {
    return normalizeWafPluginIds(
      (JSON.parse(meta) as { waf?: { plugin_ids?: unknown } })?.waf?.plugin_ids,
    );
  } catch {
    return [];
  }
}

/** Plugins selected nowhere are absent. */
export async function getCrsPluginUsage(): Promise<Map<number, CrsPluginUsage>> {
  const [global, dashboard, hosts] = await Promise.all([
    getWafSettings(),
    getDashboardSettings(),
    db.select({ id: proxyHosts.id, name: proxyHosts.name, meta: proxyHosts.meta }).from(proxyHosts),
  ]);
  const usage = new Map<number, CrsPluginUsage>();
  const entry = (id: number) => {
    const found = usage.get(id) ?? { global: false, dashboard: false, hosts: [] };
    usage.set(id, found);
    return found;
  };
  for (const id of normalizeWafPluginIds(global?.plugin_ids)) entry(id).global = true;
  for (const id of pluginIdsInMeta(dashboard?.options?.meta ?? null)) entry(id).dashboard = true;
  for (const host of hosts) {
    for (const id of pluginIdsInMeta(host.meta))
      entry(id).hosts.push({ id: host.id, name: host.name });
  }
  return usage;
}

/** Throws unless every id names an installed plugin, so a selection never emits nothing. */
export async function assertCrsPluginIdsExist(ids: readonly number[] | undefined): Promise<void> {
  if (!ids || ids.length === 0) return;
  const rows = await db
    .select({ id: crsPlugins.id })
    .from(crsPlugins)
    .where(inArray(crsPlugins.id, [...ids]));
  const known = new Set(rows.map((row) => row.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw domainError("crsPluginUnknownIds", { ids: unknown.map(String) }, { status: 400 });
  }
}

export type CrsRegistryListing = CrsListedPlugin & {
  registryName: string;
  installedId: number | null;
  /** Null until a check has reached a verdict, or when it found the plugin installable. */
  unsupported: CrsUnsupportedReason | null;
  checkedVersion: string | null;
};

/**
 * Every configured registry's plugins, from what the last read stored. Only a registry the stored
 * lists do not match yet is read now, and that read makes no GitHub API calls.
 */
export async function listCrsRegistry(fetcher?: Fetcher): Promise<CrsRegistryListing[]> {
  const state = (await crsRegistryListsStale())
    ? await refreshCrsRegistryLists(fetcher)
    : await getCrsRegistryState();
  const [installed, { registries }] = await Promise.all([
    listCrsPlugins(),
    getCrsRegistrySettings(),
  ]);
  const names = new Map(registries.map((source) => [source.id, source.name]));
  return state.entries.map((entry) => {
    const verdict = state.verdicts[verdictKey(entry)];
    const current = verdict?.repository === entry.repository ? verdict : undefined;
    return {
      ...entry,
      registryName: names.get(entry.registryId) ?? entry.registryId,
      installedId:
        installed.find(
          (plugin) => plugin.name === entry.name && plugin.repository === entry.repository,
        )?.id ?? null,
      unsupported: current && !current.supported ? current.reason : null,
      checkedVersion: current?.version ?? null,
    };
  });
}

async function githubFetcher(fetcher?: Fetcher): Promise<Fetcher> {
  return withGitHubToken(fetcher ?? fetch, await crsRegistryGithubToken());
}

async function registryEntry(
  registryId: string,
  name: string,
  fetcher?: Fetcher,
): Promise<CrsListedPlugin> {
  const entry = (await listCrsRegistry(fetcher)).find(
    (candidate) => candidate.registryId === registryId && candidate.name === name,
  );
  if (!entry) throw domainError("crsPluginNotInRegistry", { name }, { status: 404 });
  return entry;
}

/** id -> the latest version upstream, for plugins that have a newer one than installed. */
export async function checkCrsPluginUpdates(fetcher?: Fetcher): Promise<Map<number, string>> {
  const github = await githubFetcher(fetcher);
  const updates = new Map<number, string>();
  for (const plugin of await listCrsPlugins()) {
    const latest = await resolveCrsPluginVersion(plugin, github);
    if (latest !== plugin.version) updates.set(plugin.id, latest);
  }
  return updates;
}

/** The same, from the last scheduled check: no GitHub calls, for a page to render with. */
export async function storedCrsPluginUpdates(): Promise<Map<number, string>> {
  const [plugins, state] = await Promise.all([listCrsPlugins(), getCrsRegistryState()]);
  const updates = new Map<number, string>();
  for (const plugin of plugins) {
    const latest = state.latestVersions[plugin.repository];
    if (latest && latest !== plugin.version) updates.set(plugin.id, latest);
  }
  return updates;
}

/** For the scheduled check: installed plugins' repositories, listed in a registry or not. */
export async function installedCrsPluginRepositories(): Promise<string[]> {
  return [...new Set((await listCrsPlugins()).map((plugin) => plugin.repository))];
}

/**
 * Two registries allocate rule ids independently, so their ranges can collide. Coraza refuses a
 * duplicate id, and that refusal takes every host's config down, so an overlap is refused here.
 */
async function assertRangeFree(start: number, end: number, exceptId: number | null): Promise<void> {
  const clash = (await listCrsPlugins()).find(
    (plugin) => plugin.id !== exceptId && plugin.ruleIdStart <= end && start <= plugin.ruleIdEnd,
  );
  if (clash) {
    throw domainError(
      "crsPluginRangeOverlaps",
      { name: clash.name, start: String(clash.ruleIdStart), end: String(clash.ruleIdEnd) },
      { status: 409 },
    );
  }
}

// ── Writes ───────────────────────────────────────────────────────────

export async function installCrsPlugin(
  registryId: string,
  name: string,
  actorUserId: number,
  fetcher?: Fetcher,
): Promise<CrsPlugin> {
  const existing = await db.query.crsPlugins.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.name, name),
  });
  if (existing) throw domainError("crsPluginAlreadyInstalled", { name }, { status: 409 });

  const entry = await registryEntry(registryId, name, fetcher);
  await assertRangeFree(entry.ruleIdStart, entry.ruleIdEnd, null);
  const github = await githubFetcher(fetcher);
  const version = await resolveCrsPluginVersion(entry, github);
  const release = await fetchCrsPluginRelease(entry, version, github);
  await assertPluginLoads(null, {
    config: release.configRules,
    before: release.beforeRules,
    after: release.afterRules,
  });
  const now = nowIso();
  const [record] = await db
    .insert(crsPlugins)
    .values({
      name: entry.name,
      repository: entry.repository,
      version: release.version,
      description: release.description,
      ruleIdStart: entry.ruleIdStart,
      ruleIdEnd: entry.ruleIdEnd,
      configRules: release.configRules,
      beforeRules: release.beforeRules,
      afterRules: release.afterRules,
      configOverride: null,
      fileNames: JSON.stringify(release.fileNames),
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "crs_plugin",
    entityId: record.id,
    summary: `Installed CRS plugin ${entry.name} ${release.version}`,
  });

  // Nothing selects a new plugin yet, so there is no config to apply.
  return toCrsPlugin(record);
}

/**
 * Has Caddy compile the plugin alongside the CRS, and in every WAF selecting it, with `rules` in
 * place of what is stored. A plugin being installed has no id yet and nothing selects it.
 */
async function assertPluginLoads(id: number | null, rules: CrsPluginRules): Promise<void> {
  const probeId = id ?? 0;
  const plugins = new Map(await getCrsPluginRules()).set(probeId, rules);
  const alone = {
    enabled: true,
    mode: "On" as const,
    load_owasp_crs: true,
    custom_directives: "",
    plugin_ids: [probeId],
  };
  const selecting =
    id === null
      ? []
      : await wafCandidatesSelecting(
          (waf) => waf.load_owasp_crs && (waf.plugin_ids ?? []).includes(id),
        );
  await assertWafLoads([{ target: { kind: "plugin" }, waf: alone }, ...selecting], { plugins });
}

async function applyIfSelected(id: number): Promise<void> {
  if ((await getCrsPluginUsage()).has(id)) await applyCaddyConfig();
}

/** Re-fetches at the latest version. The operator's config edit is kept. */
export async function updateCrsPlugin(
  id: number,
  actorUserId: number,
  fetcher?: Fetcher,
): Promise<CrsPlugin> {
  const existing = await getCrsPlugin(id);
  if (!existing) throw domainError("crsPluginNotFound", {}, { status: 404 });

  // The registry that listed it may be gone, or list a different plugin by that name now: the
  // repository and range it was installed with stand in.
  const listed = (await listCrsRegistry(fetcher)).find(
    (candidate) => candidate.name === existing.name && candidate.repository === existing.repository,
  );
  const entry = listed ?? {
    repository: existing.repository,
    ruleIdStart: existing.ruleIdStart,
    ruleIdEnd: existing.ruleIdEnd,
  };
  if (listed) await assertRangeFree(listed.ruleIdStart, listed.ruleIdEnd, id);
  const github = await githubFetcher(fetcher);
  const version = await resolveCrsPluginVersion(entry, github);
  if (version === existing.version) return existing;
  const release = await fetchCrsPluginRelease(entry, version, github);
  // A range the registry moved would strand an edited config's rule ids outside it.
  if (existing.configOverride !== null) {
    assertCrsPluginRulesLoadable([existing.configOverride], entry.ruleIdStart, entry.ruleIdEnd);
  }
  await assertPluginLoads(id, {
    config: existing.configOverride ?? release.configRules,
    before: release.beforeRules,
    after: release.afterRules,
  });

  const [record] = await db
    .update(crsPlugins)
    .set({
      repository: entry.repository,
      version: release.version,
      description: release.description,
      ruleIdStart: entry.ruleIdStart,
      ruleIdEnd: entry.ruleIdEnd,
      configRules: release.configRules,
      beforeRules: release.beforeRules,
      afterRules: release.afterRules,
      fileNames: JSON.stringify(release.fileNames),
      updatedAt: nowIso(),
    })
    .where(eq(crsPlugins.id, id))
    .returning();

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "crs_plugin",
    entityId: id,
    summary: `Updated CRS plugin ${existing.name} to ${release.version}`,
  });

  // A new release or config is worth another try, if Caddy refused the old one.
  await releaseCrsPlugin(id);
  await applyIfSelected(id);
  return toCrsPlugin(record);
}

/** Replaces the plugin's -config file. Blank, or the upstream text, goes back to upstream. */
export async function setCrsPluginConfig(
  id: number,
  config: string | null,
  actorUserId: number,
): Promise<CrsPlugin> {
  const existing = await getCrsPlugin(id);
  if (!existing) throw domainError("crsPluginNotFound", {}, { status: 404 });

  const trimmed = config?.replace(/\r\n?/g, "\n").trim() ?? "";
  const override = trimmed && trimmed !== existing.configRules.trim() ? trimmed : null;
  if (override !== null) {
    assertCrsPluginRulesLoadable([override], existing.ruleIdStart, existing.ruleIdEnd);
  }
  if (override === existing.configOverride) return existing;
  await assertPluginLoads(id, {
    config: override ?? existing.configRules,
    before: existing.beforeRules,
    after: existing.afterRules,
  });

  const [record] = await db
    .update(crsPlugins)
    .set({ configOverride: override, updatedAt: nowIso() })
    .where(eq(crsPlugins.id, id))
    .returning();

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "crs_plugin",
    entityId: id,
    summary: `Configured CRS plugin ${existing.name}`,
  });

  // A new release or config is worth another try, if Caddy refused the old one.
  await releaseCrsPlugin(id);
  await applyIfSelected(id);
  return toCrsPlugin(record);
}

/** Refuses while anything selects the plugin: dropping it silently changes that host's WAF. */
export async function uninstallCrsPlugin(id: number, actorUserId: number): Promise<void> {
  const existing = await getCrsPlugin(id);
  if (!existing) throw domainError("crsPluginNotFound", {}, { status: 404 });

  const usage = (await getCrsPluginUsage()).get(id);
  if (usage?.global) throw domainError("crsPluginInUseGlobally", {}, { status: 409 });
  if (usage?.dashboard) throw domainError("crsPluginInUseByDashboard", {}, { status: 409 });
  if (usage && usage.hosts.length > 0) {
    throw domainError(
      "crsPluginInUseByHosts",
      { hosts: usage.hosts.map((host) => host.name) },
      { status: 409 },
    );
  }

  await db.delete(crsPlugins).where(eq(crsPlugins.id, id));
  await releaseCrsPlugin(id);

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "crs_plugin",
    entityId: id,
    summary: `Uninstalled CRS plugin ${existing.name}`,
  });
}

/** Installed plugins Caddy refused to load the WAF with, by id; see crs-plugins/recovery.ts. */
export async function crsPluginLoadFailures(): Promise<Map<number, CrsPluginLoadFailure>> {
  const [quarantine, plugins] = await Promise.all([getCrsPluginQuarantine(), listCrsPlugins()]);
  return new Map(
    plugins.flatMap((plugin) => {
      const failure = quarantine[plugin.id];
      return failure ? [[plugin.id, failure] as const] : [];
    }),
  );
}

/**
 * Switches a disabled plugin back on and applies the config. Returns false when Caddy refused it
 * again, in which case the recovery has switched it off once more.
 */
export async function retryCrsPlugin(id: number, actorUserId: number): Promise<boolean> {
  const existing = await getCrsPlugin(id);
  if (!existing) throw domainError("crsPluginNotFound", {}, { status: 404 });
  if (!(await releaseCrsPlugin(id))) return true;
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "crs_plugin",
    entityId: id,
    summary: `Re-enabled CRS plugin ${existing.name}`,
  });
  await applyCaddyConfig();
  return !(id in (await getCrsPluginQuarantine()));
}
