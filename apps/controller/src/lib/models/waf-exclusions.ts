/**
 * Scoped WAF exclusions. A change is compiled by Coraza on an agent before it is stored, and
 * undone again when Caddy refuses the config it produces.
 */

import { asc, eq } from "drizzle-orm";
import db, { nowIso, toIso } from "../db";
import { proxyHosts, users, wafExclusions } from "../db/schema";
import { logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";
import { applyCaddyConfig } from "../caddy";
import { CaddyApplyError } from "../caddy/apply-error";
import { domainError } from "../errors/domain-error";
import {
  ExclusionInputError,
  type WafExclusionRule,
  normalizeExclusionPath,
  normalizeExclusionReason,
  normalizeExclusionTarget,
  validateExclusionRuleId,
} from "../waf/exclusions";
import { assertWafLoads, wafCandidatesForExclusions } from "../waf/dry-run";

export type WafExclusion = WafExclusionRule & {
  /** Null for a global exclusion. */
  hostName: string | null;
  reason: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WafExclusionInput = {
  ruleId: number | string;
  proxyHostId?: number | null;
  path?: string | null;
  target?: string | null;
  reason?: string | null;
};

type Row = typeof wafExclusions.$inferSelect;

function toRule(row: Row): WafExclusionRule {
  return {
    id: row.id,
    ruleId: row.ruleId,
    proxyHostId: row.proxyHostId ?? null,
    path: row.path ?? null,
    target: row.target ?? null,
  };
}

export async function listWafExclusionRules(): Promise<WafExclusionRule[]> {
  const rows = await db.select().from(wafExclusions).orderBy(asc(wafExclusions.id));
  return rows.map(toRule);
}

export async function listWafExclusions(): Promise<WafExclusion[]> {
  const rows = await db
    .select({
      exclusion: wafExclusions,
      hostName: proxyHosts.name,
      author: users.name,
      email: users.email,
    })
    .from(wafExclusions)
    .leftJoin(proxyHosts, eq(proxyHosts.id, wafExclusions.proxyHostId))
    .leftJoin(users, eq(users.id, wafExclusions.createdBy))
    .orderBy(asc(wafExclusions.ruleId), asc(wafExclusions.id));
  return rows.map(({ exclusion, hostName, author, email }) => ({
    ...toRule(exclusion),
    hostName: hostName ?? null,
    reason: exclusion.reason,
    createdBy: author || email || null,
    createdAt: toIso(exclusion.createdAt)!,
    updatedAt: toIso(exclusion.updatedAt)!,
  }));
}

type Normalized = Omit<WafExclusionRule, "id"> & { reason: string };

async function normalizeInput(input: WafExclusionInput): Promise<Normalized> {
  let normalized: Normalized;
  try {
    normalized = {
      ruleId: validateExclusionRuleId(input.ruleId),
      proxyHostId: input.proxyHostId ?? null,
      path: normalizeExclusionPath(input.path),
      target: normalizeExclusionTarget(input.target),
      reason: normalizeExclusionReason(input.reason),
    };
  } catch (error) {
    if (error instanceof ExclusionInputError) {
      throw domainError(error.code, {}, { status: 400 });
    }
    throw error;
  }
  if (normalized.proxyHostId !== null) {
    const host = await db.query.proxyHosts.findFirst({
      where: (table, { eq: same }) => same(table.id, normalized.proxyHostId as number),
    });
    if (!host) throw domainError("wafExclusionHostNotFound", {}, { status: 400 });
  }
  return normalized;
}

function sameScope(a: Omit<WafExclusionRule, "id">, b: Omit<WafExclusionRule, "id">): boolean {
  return (
    a.ruleId === b.ruleId &&
    a.proxyHostId === b.proxyHostId &&
    a.path === b.path &&
    a.target === b.target
  );
}

/**
 * Applies after a write; when Caddy refuses the result, `undo` restores the rows and the config
 * is applied again, so a refused exclusion never stays stored. An unreachable Caddy keeps the
 * write, which the monitor applies once Caddy is back.
 */
async function applyOrRollBack(undo: () => Promise<void>): Promise<void> {
  try {
    await applyCaddyConfig();
  } catch (error) {
    if (!(error instanceof CaddyApplyError) || error.code !== "CADDY_REJECTED") return;
    await undo();
    try {
      await applyCaddyConfig();
    } catch (reapplyError) {
      console.error("[waf] re-applying after a refused exclusion failed:", reapplyError);
    }
    throw domainError("wafExclusionRejected", {}, { status: 400 });
  }
}

export async function createWafExclusion(
  input: WafExclusionInput,
  actorUserId: number,
): Promise<WafExclusion> {
  const next = await normalizeInput(input);
  const current = await listWafExclusionRules();
  if (current.some((rule) => sameScope(rule, next))) {
    throw domainError("wafExclusionDuplicate", {}, { status: 409 });
  }
  // The next id is unknown until the insert; the dry run only needs one that is not taken.
  const probeId = Math.max(0, ...current.map((rule) => rule.id)) + 1;
  await assertWafLoads(await wafCandidatesForExclusions([...current, { ...next, id: probeId }]));

  const now = nowIso();
  const [record] = await db
    .insert(wafExclusions)
    .values({ ...next, createdBy: actorUserId, createdAt: now, updatedAt: now })
    .returning();
  await applyOrRollBack(async () => {
    await db.delete(wafExclusions).where(eq(wafExclusions.id, record.id));
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "waf_exclusion",
    entityId: record.id,
    summary: `Added an exclusion for WAF rule ${next.ruleId}`,
    data: { ...next },
  });
  return (await listWafExclusions()).find((row) => row.id === record.id)!;
}

export async function updateWafExclusion(
  id: number,
  input: WafExclusionInput,
  actorUserId: number,
): Promise<WafExclusion> {
  const current = await listWafExclusionRules();
  const existingRow = await db.query.wafExclusions.findFirst({
    where: (table, { eq: same }) => same(table.id, id),
  });
  if (!existingRow) throw domainError("wafExclusionNotFound", {}, { status: 404 });
  const next = await normalizeInput(input);
  if (current.some((rule) => rule.id !== id && sameScope(rule, next))) {
    throw domainError("wafExclusionDuplicate", {}, { status: 409 });
  }
  await assertWafLoads(
    await wafCandidatesForExclusions(
      current.map((rule) => (rule.id === id ? { ...next, id } : rule)),
    ),
  );
  await db
    .update(wafExclusions)
    .set({ ...next, updatedAt: nowIso() })
    .where(eq(wafExclusions.id, id));
  await applyOrRollBack(async () => {
    const { id: _id, ...previous } = existingRow;
    await db.update(wafExclusions).set(previous).where(eq(wafExclusions.id, id));
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "waf_exclusion",
    entityId: id,
    summary: `Changed the exclusion for WAF rule ${next.ruleId}`,
    data: { before: toRule(existingRow), after: next },
    changes: diffAuditRecords(toRule(existingRow), next),
  });
  return (await listWafExclusions()).find((row) => row.id === id)!;
}

export async function deleteWafExclusion(id: number, actorUserId: number): Promise<void> {
  const existingRow = await db.query.wafExclusions.findFirst({
    where: (table, { eq: same }) => same(table.id, id),
  });
  if (!existingRow) throw domainError("wafExclusionNotFound", {}, { status: 404 });
  await db.delete(wafExclusions).where(eq(wafExclusions.id, id));
  await applyOrRollBack(async () => {
    await db.insert(wafExclusions).values(existingRow);
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "waf_exclusion",
    entityId: id,
    summary: `Removed the exclusion for WAF rule ${existingRow.ruleId}`,
    data: toRule(existingRow),
  });
}

// ── Migration of the rule-id lists ────────────────────────────────────

function idsOf(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0),
    ),
  ];
}

/**
 * Moves the global and per-host `excluded_rule_ids` into exclusions, emptying the lists, so the
 * config does not change. Idempotent: an id already excluded the same way is not added twice.
 * Returns how many exclusions it created.
 */
export async function migrateLegacyWafSuppressions(): Promise<number> {
  const { getWafSettings, saveWafSettingsUnchecked } = await import("../settings");
  const existing = await listWafExclusionRules();
  const has = (ruleId: number, proxyHostId: number | null) =>
    existing.some((rule) => sameScope(rule, { ruleId, proxyHostId, path: null, target: null }));
  const now = nowIso();
  let created = 0;
  const insert = async (ruleId: number, proxyHostId: number | null) => {
    if (has(ruleId, proxyHostId)) return;
    await db.insert(wafExclusions).values({
      ruleId,
      proxyHostId,
      path: null,
      target: null,
      reason: "",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
    existing.push({ id: -1, ruleId, proxyHostId, path: null, target: null });
    created++;
  };

  const global = await getWafSettings();
  const globalIds = idsOf(global?.excluded_rule_ids);
  if (global && globalIds.length > 0) {
    for (const id of globalIds) await insert(id, null);
    const { excluded_rule_ids: _legacy, ...rest } = global;
    await saveWafSettingsUnchecked(rest);
  }

  const hosts = await db.select({ id: proxyHosts.id, meta: proxyHosts.meta }).from(proxyHosts);
  for (const host of hosts) {
    if (!host.meta) continue;
    let meta: { waf?: { excluded_rule_ids?: unknown } };
    try {
      meta = JSON.parse(host.meta);
    } catch {
      continue;
    }
    const ids = idsOf(meta?.waf?.excluded_rule_ids);
    if (!meta?.waf || ids.length === 0) continue;
    for (const id of ids) await insert(id, host.id);
    delete meta.waf.excluded_rule_ids;
    await db
      .update(proxyHosts)
      .set({ meta: JSON.stringify(meta) })
      .where(eq(proxyHosts.id, host.id));
  }

  if (created > 0) {
    await logAuditEvent({
      userId: null,
      action: "update",
      entityType: "waf_exclusion",
      entityId: null,
      summary: `Moved suppressed WAF rules into exclusions (${created})`,
    });
  }
  return created;
}
