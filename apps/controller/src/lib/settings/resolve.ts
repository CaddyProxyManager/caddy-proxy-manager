/**
 * Stored value, then environment, then default: until something is stored every setting resolves
 * from its old variable. `SETTINGS_ENV_OVERRIDE` reverses that per variable (`isEnvOverridden`).
 * Cached per process; saves clear it, so only a direct table write goes stale.
 */
import { eq, inArray, sql } from "drizzle-orm";
import db, { nowIso } from "../db";
import { settings } from "../db/schema";
import { decryptSecret, encryptSecret } from "../secret";
import {
  SETTINGS_BY_KEY,
  SETTING_DEFINITIONS,
  SettingValidationError,
  type SettingDefinition,
  type SettingValue,
} from "./registry";

/** The promise, not the map, so concurrent cold reads share one query. */
let cache: Promise<Map<string, SettingValue>> | null = null;

/** For the tests and the migration flow. */
export function invalidateSettingsCache(): void {
  cache = null;
}

function decode(definition: SettingDefinition, raw: string): SettingValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`Ignoring unparseable stored value for ${definition.key}`);
    return undefined;
  }

  const value = definition.secret && typeof parsed === "string" ? decryptSecret(parsed) : parsed;

  try {
    return definition.parse(value);
  } catch (error) {
    // A value that no longer validates (a tightened range) must not take the app down.
    console.warn(`Ignoring invalid stored value for ${definition.key}:`, error);
    return undefined;
  }
}

function load(): Promise<Map<string, SettingValue>> {
  if (!cache) {
    const pending = loadStored();
    cache = pending;
    // A failed read must not stick.
    pending.catch(() => {
      if (cache === pending) cache = null;
    });
  }
  return cache;
}

async function loadStored(): Promise<Map<string, SettingValue>> {
  const keys = SETTING_DEFINITIONS.map((definition) => definition.key);
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys));

  const loaded = new Map<string, SettingValue>();
  for (const row of rows) {
    const definition = SETTINGS_BY_KEY.get(row.key);
    if (!definition) continue;
    const value = decode(definition, row.value);
    if (value !== undefined) loaded.set(row.key, value);
  }

  return loaded;
}

function fromEnvironment(definition: SettingDefinition): SettingValue | undefined {
  const raw = process.env[definition.env];
  if (raw === undefined) return undefined;
  // Empty is unset, except for a tri-state setting, which parses it to an explicit null.
  if (raw.trim() === "" && definition.default !== null) return undefined;

  try {
    return definition.fromEnv(raw);
  } catch (error) {
    console.warn(`Ignoring invalid ${definition.env}:`, error);
    return undefined;
  }
}

/**
 * Opt-in per variable, not a definition flag: Compose passes `BASE_URL` and friends on every
 * deployment, so "the variable always wins" would lock them out of Settings.
 */
function overriddenVariables(): Set<string> {
  const raw = process.env.SETTINGS_ENV_OVERRIDE;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((name) => name.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * The way back from a saved value that locks the operator out (OIDC-only before OAuth works, a
 * public URL off the redirect URI), which a Settings page nobody can reach cannot fix.
 */
export function isEnvOverridden(definition: SettingDefinition): boolean {
  return overriddenVariables().has(definition.env) && process.env[definition.env] !== undefined;
}

/** Shown to the operator by the setup and migration pages. */
export type SettingSource = "stored" | "environment" | "default";

export type ResolvedSetting<T extends SettingValue = SettingValue> = {
  value: T;
  source: SettingSource;
};

export async function resolveSetting<T extends SettingValue>(
  definition: SettingDefinition<T>,
): Promise<ResolvedSetting<T>> {
  const environment = fromEnvironment(definition);
  if (environment !== undefined && isEnvOverridden(definition as SettingDefinition)) {
    return { value: environment as T, source: "environment" };
  }

  const stored = (await load()).get(definition.key);
  if (stored !== undefined) return { value: stored as T, source: "stored" };

  if (environment !== undefined) return { value: environment as T, source: "environment" };

  return { value: definition.default, source: "default" };
}

export async function getSetting<T extends SettingValue>(
  definition: SettingDefinition<T>,
): Promise<T> {
  return (await resolveSetting(definition)).value;
}

export async function resolveAllSettings(): Promise<Map<string, ResolvedSetting>> {
  await load();
  const resolved = new Map<string, ResolvedSetting>();
  // Widened: the union of per-entry value types does not infer through a generic.
  for (const definition of SETTING_DEFINITIONS as readonly SettingDefinition[]) {
    resolved.set(definition.key, await resolveSetting(definition));
  }
  return resolved;
}

/** All or nothing: everything is validated before anything is written. */
export async function saveSettings(values: Record<string, unknown>): Promise<void> {
  const writes: Array<{ key: string; value: string }> = [];

  for (const [key, raw] of Object.entries(values)) {
    const definition = SETTINGS_BY_KEY.get(key);
    if (!definition) {
      throw new SettingValidationError(key, "unknown", { label: key }, `Unknown setting "${key}"`);
    }

    const parsed = definition.parse(raw);
    const encoded =
      definition.secret && typeof parsed === "string" && parsed !== ""
        ? encryptSecret(parsed)
        : parsed;
    writes.push({ key, value: JSON.stringify(encoded) });
  }

  if (writes.length > 0) {
    const now = nowIso();
    // Keys are unique here, which a multi-row upsert requires.
    await db
      .insert(settings)
      .values(writes.map((write) => ({ key: write.key, value: write.value, updatedAt: now })))
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`excluded.value`, updatedAt: now },
      });
  }

  invalidateSettingsCache();
}

export async function clearStoredSetting(key: string): Promise<void> {
  if (!SETTINGS_BY_KEY.has(key)) {
    throw new SettingValidationError(key, "unknown", { label: key }, `Unknown setting "${key}"`);
  }
  await db.delete(settings).where(eq(settings.key, key));
  invalidateSettingsCache();
}

/** True once the deployment has been through setup or migration. */
export async function hasStoredSettings(): Promise<boolean> {
  return (await load()).size > 0;
}
