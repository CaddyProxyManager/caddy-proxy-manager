/**
 * Caddy image builds, which the agent runs. *desired* is the admin's selection and drives the UI;
 * *applied* is what the running binary was built with. Caddy rejects a whole config naming an
 * unknown module, so generation uses only the intersection of the two.
 */

import crypto from "node:crypto";
import { type CaddyBuildState, type CaddyBuildStatus, SHIPPED_CADDY_MODULES } from "@cpm/shared";
import {
  CADDY_MODULES,
  PREVIOUS_MODULE_PATHS,
  type CaddyCustomModule,
  type CaddyFeatureId,
  type CaddyModuleDefinition,
  customModuleProblem,
  customModuleSpec,
  findCaddyModule,
  modulesForFeature,
  normalizeModulePath,
  validateCustomModule,
} from "./modules";
import { domainError } from "../../errors/domain-error";
import { type CaddyBuildSettings, getCaddyBuildSettings } from "../../settings";

import {
  caddyBuildAgents,
  getAgentStatusFor,
  getAllAgentStatuses,
  requestCaddyBuild,
  requestCaddyImageLoad,
  tryGetAgentStatus,
} from "../../agent/client";
import { getAgentBuildSettings } from "../../models/agents";

export type { CaddyBuildState, CaddyBuildStatus };

export type CaddyBuildDiff = {
  /** `--with` specs the running image was built with. */
  appliedSpecs: string[];
  /** `--with` specs the current selection would build. */
  desiredSpecs: string[];
  /** Specs a rebuild would add. */
  added: string[];
  /** Specs a rebuild would remove. */
  removed: string[];
  needsRebuild: boolean;
};

// ─── Selection ───────────────────────────────────────────────────────────────

/** A missing module id counts as enabled, so one added to the catalog since the last save is on. */
export function resolveEnabledModuleIds(settings: CaddyBuildSettings | null): string[] {
  const overrides = settings?.modules ?? {};
  return CADDY_MODULES.filter((m) => overrides[m.id] ?? m.defaultEnabled !== false).map(
    (m) => m.id,
  );
}

export function resolveCustomModules(settings: CaddyBuildSettings | null): CaddyCustomModule[] {
  return (settings?.customModules ?? []).filter(
    (entry) => entry.enabled && validateCustomModule(entry) === null,
  );
}

/** The `--with` list for a selection, sorted so toggle order never changes the hash. */
export function resolveModuleSpecs(settings: CaddyBuildSettings | null): string[] {
  const builtIn = resolveEnabledModuleIds(settings).map(
    (id) => findCaddyModule(id)?.modulePath ?? id,
  );
  const custom = resolveCustomModules(settings).map(customModuleSpec);
  return Array.from(new Set([...builtIn, ...custom])).sort();
}

/** Specs the shipped image is built with - the baseline before any rebuild. */
export function defaultModuleSpecs(): string[] {
  return [...SHIPPED_CADDY_MODULES].sort();
}

// ─── Applied state ───────────────────────────────────────────────────────────

/**
 * What agents report having built, never the selection, or a pending or failed build would emit
 * handlers the binary lacks. Fleet-wide it is the intersection, since one document goes everywhere;
 * an unreachable agent is skipped, so it cannot strip plugins from the reachable ones.
 */
export async function getAppliedModuleSpecs(agentRowId?: number): Promise<string[]> {
  // One agent's document is built for it alone. Null or disconnected means the shipped image.
  if (agentRowId !== undefined) {
    const status = await getAgentStatusFor(agentRowId);
    const applied = status?.caddyBuild.applied;
    return applied && applied.length > 0 ? [...applied].sort() : defaultModuleSpecs();
  }

  const statuses = await getAllAgentStatuses();
  const reachable = statuses.filter((result) => result.ok);
  if (reachable.length === 0) return defaultModuleSpecs();

  let intersection: Set<string> | null = null;
  for (const result of reachable) {
    if (!result.ok) continue;
    const applied = result.value.caddyBuild.applied;
    const specs = new Set<string>(applied && applied.length > 0 ? applied : defaultModuleSpecs());
    if (intersection === null) {
      intersection = specs;
      continue;
    }
    const carried: Set<string> = intersection;
    intersection = new Set([...carried].filter((spec) => specs.has(spec)));
  }

  return [...(intersection ?? new Set<string>(defaultModuleSpecs()))].sort();
}

/** Split the whitespace-separated CADDY_MODULES build arg into specs. */
export function parseModuleSpecList(value: string): string[] {
  return value
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/** An agent's own module selection if it has one, else the fleet default. */
export async function resolveBuildSettingsFor(
  agentRowId?: number,
): Promise<CaddyBuildSettings | null> {
  if (agentRowId !== undefined) {
    const own = await getAgentBuildSettings(agentRowId);
    if (own) return own;
  }
  return getCaddyBuildSettings();
}

function hashSpecs(specs: string[]): string {
  return crypto.createHash("sha256").update(specs.join(" ")).digest("hex").slice(0, 16);
}

export async function getCaddyBuildDiff(agentRowId?: number): Promise<CaddyBuildDiff> {
  const [settings, appliedSpecs] = await Promise.all([
    resolveBuildSettingsFor(agentRowId),
    getAppliedModuleSpecs(agentRowId),
  ]);
  const desiredSpecs = resolveModuleSpecs(settings);
  const appliedSet = new Set(appliedSpecs);
  const desiredSet = new Set(desiredSpecs);
  return {
    appliedSpecs,
    desiredSpecs,
    added: desiredSpecs.filter((s) => !appliedSet.has(s)),
    removed: appliedSpecs.filter((s) => !desiredSet.has(s)),
    needsRebuild: hashSpecs(appliedSpecs) !== hashSpecs(desiredSpecs),
  };
}

// ─── Feature gating ──────────────────────────────────────────────────────────

export type CaddyModuleAvailability = {
  /** Feature is selected by the admin - used to decide what the UI offers. */
  desired: Set<CaddyFeatureId>;
  /** Feature is in the running binary - used to decide what config may emit. */
  applied: Set<CaddyFeatureId>;
  /** Module paths present in the running binary. */
  appliedPaths: Set<string>;
  /** Module ids the admin has selected. */
  desiredIds: Set<string>;
};

function featuresForPaths(paths: Set<string>): Set<CaddyFeatureId> {
  const features = new Set<CaddyFeatureId>();
  for (const module of CADDY_MODULES) {
    if (!paths.has(module.modulePath)) continue;
    for (const feature of module.features) features.add(feature);
  }
  return features;
}

export async function getCaddyModuleAvailability(
  agentRowId?: number,
): Promise<CaddyModuleAvailability> {
  const [settings, appliedSpecs] = await Promise.all([
    resolveBuildSettingsFor(agentRowId),
    getAppliedModuleSpecs(agentRowId),
  ]);
  const desiredIds = new Set(resolveEnabledModuleIds(settings));
  const desiredPaths = new Set(
    Array.from(desiredIds, (id) => findCaddyModule(id)?.modulePath).filter((p): p is string =>
      Boolean(p),
    ),
  );
  // Custom modules map to no feature, but a caller checking a path must still find them.
  const appliedPaths = new Set(
    appliedSpecs.map((spec) => {
      const path = stripVersion(spec);
      return PREVIOUS_MODULE_PATHS[path] ?? path;
    }),
  );
  return {
    desired: featuresForPaths(desiredPaths),
    applied: featuresForPaths(appliedPaths),
    appliedPaths,
    desiredIds,
  };
}

function stripVersion(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Whether generation may emit a feature's handlers: selected *and* compiled into the binary. */
export function isFeatureUsable(
  availability: CaddyModuleAvailability,
  feature: CaddyFeatureId,
): boolean {
  return availability.desired.has(feature) && availability.applied.has(feature);
}

/** Whether an HTTP cache storage is selected and compiled in; HTTP Cache itself is checked apart. */
export function isCacheStorageUsable(
  availability: CaddyModuleAvailability,
  storage: string,
): boolean {
  const module = CADDY_MODULES.find((m) => m.cacheStorage === storage);
  if (!module) return false;
  return availability.desiredIds.has(module.id) && availability.appliedPaths.has(module.modulePath);
}

/**
 * Whether a DNS provider can serve an ACME DNS-01 challenge. Per-provider, unlike the coarser
 * feature check: Cloudflare compiled in says nothing about Route 53.
 */
export function isDnsProviderUsable(
  availability: CaddyModuleAvailability,
  providerName: string,
): boolean {
  const module = CADDY_MODULES.find((m) => m.dnsProvider === providerName);
  if (!module) return false;
  return availability.desiredIds.has(module.id) && availability.appliedPaths.has(module.modulePath);
}

/**
 * Names the module(s) an operator has to enable to get a feature back. `nameOf` is how a caller
 * with a reader says each name; without one it is the registry's English.
 */
export function featureModuleNames(
  feature: CaddyFeatureId,
  nameOf: (module: CaddyModuleDefinition) => string = (module) => module.name,
): string {
  return modulesForFeature(feature).map(nameOf).join(", ");
}

// ─── Build ───────────────────────────────────────────────────────────────────

/** Validated here too: the REST API reaches this, and a bad path fails opaquely in the build. */
export async function applyCaddyBuild(agentRowId?: number): Promise<CaddyBuildStatus> {
  const settings = await resolveBuildSettingsFor(agentRowId);

  for (const entry of settings?.customModules ?? []) {
    if (!entry.enabled) continue;
    const problem = customModuleProblem(entry);
    if (problem) throw problem;
  }

  // Re-apply first: under `--resume` a recreated Caddy reloads its autosave, and one naming a
  // module the new binary lacks leaves it down. Lazy because caddy/index.ts imports this module.
  const { applyCaddyConfig } = await import("../index");
  await applyCaddyConfig();

  return requestCaddyBuild(resolveModuleSpecs(settings));
}

/** `?agent=<row id>` on the build routes; absent or malformed is the fleet. */
export function parseAgentRowId(raw: string | null): number | undefined {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * External mode's rebuild: the operator built the image, and each targeted agent loads it. The
 * config is re-applied first for the same reason a rebuild does it.
 */
export async function loadCaddyImage(agentRowId?: number): Promise<CaddyBuildStatus> {
  if (caddyBuildAgents(agentRowId).external.length === 0) {
    throw domainError("caddyImageNoExternalAgent", {}, { status: 409 });
  }
  const { applyCaddyConfig } = await import("../index");
  await applyCaddyConfig();

  const results = await requestCaddyImageLoad(agentRowId);
  const failed = results.filter((result) => !result.ok);
  if (failed.length === results.length && failed[0] && !failed[0].ok) {
    throw domainError(
      "caddyImageLoadFailed",
      { agent: failed[0].agent, error: failed[0].error },
      { status: 502 },
    );
  }
  return { state: "pending", triggeredAt: new Date().toISOString() };
}

/** The agent's last word on the rebuild - one named agent's, or the primary's. */
export async function getCaddyBuildStatus(agentRowId?: number): Promise<CaddyBuildStatus> {
  const status =
    agentRowId === undefined ? await tryGetAgentStatus() : await getAgentStatusFor(agentRowId);
  return status?.caddyBuild.status ?? { state: "idle" };
}

/** Normalize a settings payload: drop unknown module ids, clean and validate custom entries. */
export function sanitizeCaddyBuildSettings(input: {
  modules?: Record<string, boolean>;
  customModules?: CaddyCustomModule[];
}): CaddyBuildSettings {
  const modules: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(input.modules ?? {})) {
    if (!findCaddyModule(id)) continue;
    modules[id] = Boolean(enabled);
  }

  const seen = new Set<string>();
  const customModules: CaddyCustomModule[] = [];
  for (const entry of input.customModules ?? []) {
    const modulePath = normalizeModulePath(entry.modulePath ?? "");
    if (!modulePath) continue;
    const problem = customModuleProblem({ ...entry, modulePath });
    if (problem) throw problem;
    // Otherwise the build fails later with a confusing "module already required".
    if (seen.has(modulePath)) {
      throw domainError("customModuleDuplicate", { path: modulePath }, { status: 400 });
    }
    seen.add(modulePath);
    const name = entry.name?.trim();
    customModules.push({
      ...(name ? { name } : {}),
      modulePath,
      ...(entry.version?.trim() ? { version: entry.version.trim() } : {}),
      enabled: entry.enabled !== false,
    });
  }

  return { modules, customModules };
}

// ─── UI gate ─────────────────────────────────────────────────────────────────

const GATED_FEATURES: CaddyFeatureId[] = [
  "l4",
  "geoblock",
  "waf",
  "tailscale",
  "dns01",
  "cache",
  "ratelimit",
  "crowdsec",
];

/** Gates on *desired*: following applied, a control stays greyed out right after it is enabled. */
export async function getModuleGateState(
  nameOf?: (module: CaddyModuleDefinition) => string,
): Promise<{
  features: Record<CaddyFeatureId, boolean>;
  moduleNames: Record<CaddyFeatureId, string>;
  enabledModuleIds: string[] | null;
  pendingRebuild: boolean;
}> {
  const [availability, diff] = await Promise.all([
    getCaddyModuleAvailability(),
    getCaddyBuildDiff(),
  ]);

  const features = {} as Record<CaddyFeatureId, boolean>;
  const moduleNames = {} as Record<CaddyFeatureId, string>;
  for (const feature of GATED_FEATURES) {
    features[feature] = availability.desired.has(feature);
    moduleNames[feature] = featureModuleNames(feature, nameOf);
  }

  return {
    features,
    moduleNames,
    // Per-module: Cloudflare compiled in says nothing about Route 53.
    enabledModuleIds: Array.from(availability.desiredIds),
    pendingRebuild: diff.needsRebuild,
  };
}
