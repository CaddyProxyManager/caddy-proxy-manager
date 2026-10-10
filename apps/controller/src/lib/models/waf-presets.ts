import db, { nowIso, toIso } from "../db";
import { applyCaddyConfig } from "../caddy";
import { logAuditEvent } from "../audit";
import { proxyHosts, wafPresets } from "../db/schema";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { domainError } from "../errors/domain-error";
import { customDirectivesError, normalizeWafPresetIds, seclangErrorDetails } from "../waf/caddy";
import { seclangErrors } from "../waf/seclang";
import { assertWafLoads, wafCandidatesSelecting } from "../waf/dry-run";
import { getDashboardSettings, getWafSettings } from "../settings";

// ── Types ────────────────────────────────────────────────────────────

export type WafPreset = {
  id: number;
  name: string;
  description: string | null;
  directives: string;
  createdAt: string;
  updatedAt: string;
};

export type WafPresetInput = {
  name: string;
  description?: string | null;
  directives: string;
};

/** The dashboard host has no name of its own, so it is a flag. */
export type WafPresetUsage = {
  global: boolean;
  dashboard: boolean;
  hosts: { id: number; name: string }[];
};

type PresetRow = typeof wafPresets.$inferSelect;

function toWafPreset(row: PresetRow): WafPreset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    directives: row.directives,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

/** Never the directives. */
export function toWafPresetOption(preset: WafPreset): {
  id: number;
  name: string;
  description: string | null;
} {
  return { id: preset.id, name: preset.name, description: preset.description };
}

// ── Validation ───────────────────────────────────────────────────────

/** The custom-directive filter, at write time so nothing is dropped later. */
async function validateDirectives(directives: string): Promise<string> {
  // A browser submits textarea and hidden-input values with CRLF line breaks.
  const trimmed = directives.replace(/\r\n?/g, "\n").trim();
  if (!trimmed) throw domainError("wafPresetDirectivesRequired", {}, { status: 400 });
  // A preset is emitted wherever it is selected, so the global strictness is the one that applies.
  const strictDirectives = (await getWafSettings())?.strict_directives === true;
  const directiveError = customDirectivesError(trimmed, { strictDirectives }, undefined, "preset");
  if (directiveError) throw directiveError;
  const lintErrors = seclangErrors(trimmed);
  if (lintErrors.length > 0) {
    throw domainError(
      "wafPresetDirectivesInvalid",
      { count: lintErrors.length, details: seclangErrorDetails(lintErrors) },
      { status: 400 },
    );
  }
  return trimmed;
}

/**
 * Has Caddy compile the preset on its own and in every WAF selecting it, with `directives` in
 * place of what is stored. A new preset has no id yet and nothing selects it.
 */
async function assertPresetLoads(id: number | null, directives: string): Promise<void> {
  const probeId = id ?? 0;
  const presets = new Map(await getWafPresetDirectives()).set(probeId, directives);
  const alone = {
    enabled: true,
    mode: "On" as const,
    load_owasp_crs: false,
    custom_directives: "",
    preset_ids: [probeId],
  };
  const selecting =
    id === null ? [] : await wafCandidatesSelecting((waf) => (waf.preset_ids ?? []).includes(id));
  await assertWafLoads([{ target: { kind: "preset" }, waf: alone }, ...selecting], { presets });
}

async function validateName(name: string | undefined, exceptId: number | null): Promise<string> {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) throw domainError("wafPresetNameRequired", {}, { status: 400 });
  // Case-insensitive, unlike the index: two presets told apart only by case read as one in a picker.
  const clash = await db.query.wafPresets.findFirst({
    where: (table) => sql`lower(${table.name}) = lower(${trimmed})`,
  });
  if (clash && clash.id !== exceptId) {
    throw domainError("wafPresetNameTaken", { name: trimmed }, { status: 409 });
  }
  return trimmed;
}

/** Throws unless every id names a preset, so a host never stores a selection that emits nothing. */
export async function assertWafPresetIdsExist(ids: readonly number[] | undefined): Promise<void> {
  if (!ids || ids.length === 0) return;
  const rows = await db
    .select({ id: wafPresets.id })
    .from(wafPresets)
    .where(inArray(wafPresets.id, [...ids]));
  const known = new Set(rows.map((row) => row.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw domainError("wafPresetUnknownIds", { ids: unknown.map(String) }, { status: 400 });
  }
}

// ── Reads ────────────────────────────────────────────────────────────

export async function listWafPresets(): Promise<WafPreset[]> {
  const rows = await db.query.wafPresets.findMany({ orderBy: (table) => asc(table.name) });
  return rows.map(toWafPreset);
}

export async function getWafPreset(id: number): Promise<WafPreset | null> {
  const row = await db.query.wafPresets.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  return row ? toWafPreset(row) : null;
}

export async function getWafPresetDirectives(): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: wafPresets.id, directives: wafPresets.directives })
    .from(wafPresets);
  return new Map(rows.map((row) => [row.id, row.directives]));
}

function presetIdsInMeta(meta: string | null): number[] {
  if (!meta) return [];
  try {
    return normalizeWafPresetIds(
      (JSON.parse(meta) as { waf?: { preset_ids?: unknown } })?.waf?.preset_ids,
    );
  } catch {
    return [];
  }
}

/** Presets selected nowhere are absent. */
export async function getWafPresetUsage(): Promise<Map<number, WafPresetUsage>> {
  const [global, dashboard, hosts] = await Promise.all([
    getWafSettings(),
    getDashboardSettings(),
    db.select({ id: proxyHosts.id, name: proxyHosts.name, meta: proxyHosts.meta }).from(proxyHosts),
  ]);
  const usage = new Map<number, WafPresetUsage>();
  const entry = (id: number) => {
    const found = usage.get(id) ?? { global: false, dashboard: false, hosts: [] };
    usage.set(id, found);
    return found;
  };
  for (const id of normalizeWafPresetIds(global?.preset_ids)) entry(id).global = true;
  for (const id of presetIdsInMeta(dashboard?.options?.meta ?? null)) entry(id).dashboard = true;
  for (const host of hosts) {
    for (const id of presetIdsInMeta(host.meta))
      entry(id).hosts.push({ id: host.id, name: host.name });
  }
  return usage;
}

// ── Writes ───────────────────────────────────────────────────────────

export async function createWafPreset(
  input: WafPresetInput,
  actorUserId: number,
): Promise<WafPreset> {
  const name = await validateName(input.name, null);
  const directives = await validateDirectives(input.directives ?? "");
  await assertPresetLoads(null, directives);
  const now = nowIso();
  const [record] = await db
    .insert(wafPresets)
    .values({
      name,
      description: input.description?.trim() || null,
      directives,
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "waf_preset",
    entityId: record.id,
    summary: `Created WAF preset ${name}`,
  });

  return toWafPreset(record);
}

export async function updateWafPreset(
  id: number,
  input: Partial<WafPresetInput>,
  actorUserId: number,
): Promise<WafPreset> {
  const existing = await getWafPreset(id);
  if (!existing) throw domainError("wafPresetNotFound", {}, { status: 404 });

  const name = input.name !== undefined ? await validateName(input.name, id) : existing.name;
  const directives =
    input.directives !== undefined
      ? await validateDirectives(input.directives)
      : existing.directives;
  if (directives !== existing.directives) await assertPresetLoads(id, directives);
  const description =
    input.description !== undefined ? input.description?.trim() || null : existing.description;

  const [record] = await db
    .update(wafPresets)
    .set({ name, description, directives, updatedAt: nowIso() })
    .where(eq(wafPresets.id, id))
    .returning();

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "waf_preset",
    entityId: id,
    summary: `Updated WAF preset ${name}`,
  });

  if (directives !== existing.directives && (await getWafPresetUsage()).has(id)) {
    await applyCaddyConfig();
  }
  return toWafPreset(record);
}

/** Refuses while anything selects the preset: silently dropping it would loosen that host's WAF. */
export async function deleteWafPreset(id: number, actorUserId: number): Promise<void> {
  const existing = await getWafPreset(id);
  if (!existing) throw domainError("wafPresetNotFound", {}, { status: 404 });

  const usage = (await getWafPresetUsage()).get(id);
  if (usage?.global) throw domainError("wafPresetInUseGlobally", {}, { status: 409 });
  if (usage?.dashboard) throw domainError("wafPresetInUseByDashboard", {}, { status: 409 });
  if (usage && usage.hosts.length > 0) {
    throw domainError(
      "wafPresetInUseByHosts",
      { hosts: usage.hosts.map((host) => host.name) },
      { status: 409 },
    );
  }

  await db.delete(wafPresets).where(eq(wafPresets.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "waf_preset",
    entityId: id,
    summary: `Deleted WAF preset ${existing.name}`,
  });
}
