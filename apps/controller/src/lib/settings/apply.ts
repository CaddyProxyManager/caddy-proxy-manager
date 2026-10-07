/** The only place a settings edit reaches Caddy: one reload per batch, reviewed beforehand. */

import { invalidateSettingsCache } from "./resolve";
import db, { nowIso } from "../db";
import { settings, settingsRevisions } from "../db/schema";
import { desc, sql } from "drizzle-orm";
import { applyCaddyConfig, buildCaddyDocument } from "../caddy";
import { withSettingsUpdateLock } from "./update-lock";
import { discardAllStaged, listStagedSettings, stagedOverlay, storedValues } from "./staging";
import { withStagedReads } from "./staging-context";
import { domainError } from "../errors/domain-error";
import { logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";

export type RevisionRow = {
  id: number;
  appliedByName: string | null;
  /** Kept as written, since the migration copies it; the UI renders `keys`. */
  summary: string;
  /** So the review sheet can name them in the reader's language. */
  keys: string[];
  outcome: "applied" | "failed";
  error: string | null;
  appliedAt: string;
  /** Older rows lack their values, so they can be neither compared nor restored. */
  recorded: boolean;
};

/** `before` is null for a key that had no row. */
export type RevisionChange = { before: string | null; after: string };

/** `error` is what the revision stores; `cause` is what the action renders, in the reader's language. */
export type ApplyOutcome =
  | { ok: true; revision: number }
  | { ok: false; error: string; cause: Error; revision: number };

/** The unmodified builder, with settings reads overlaid by the staged set. */
export async function renderStagedDocument(userId: number): Promise<unknown> {
  const overlay = await stagedOverlay(userId);
  return withStagedReads(overlay, () =>
    buildCaddyDocument(undefined, { includeAgentFileCertificates: true }),
  );
}

/** The current config and the staged one, for the review sheet's diff. */
export async function renderConfigComparison(
  userId: number,
): Promise<{ current: unknown; staged: unknown }> {
  const [current, staged] = await Promise.all([
    buildCaddyDocument(undefined, { includeAgentFileCertificates: true }),
    renderStagedDocument(userId),
  ]);
  return { current, staged };
}

/**
 * Under the settings lock. A failed push still commits the values and records the failure, so
 * re-applying is a retry rather than a re-entry.
 */
export async function applyStagedSettings(
  userId: number,
  appliedByName: string | null,
): Promise<ApplyOutcome> {
  return withSettingsUpdateLock(async () => {
    const staged = await listStagedSettings(userId);
    if (staged.length === 0) {
      throw domainError("nothingStagedToApply");
    }
    const outcome = await commitSettings(userId, appliedByName, staged);
    await discardAllStaged(userId);
    return outcome;
  });
}

/** A change set an approved change request carries, applied as staged settings would be. */
export async function applySettingsEntries(
  userId: number,
  appliedByName: string | null,
  entries: readonly SettingsEntry[],
): Promise<ApplyOutcome> {
  if (entries.length === 0) throw domainError("nothingStagedToApply");
  return withSettingsUpdateLock(() => commitSettings(userId, appliedByName, entries));
}

export type SettingsEntry = { key: string; value: string };

/** Under the settings lock: one upsert for the set, one push, one revision. */
async function commitSettings(
  userId: number,
  appliedByName: string | null,
  staged: readonly SettingsEntry[],
): Promise<ApplyOutcome> {
  const now = nowIso();
  const previous = await storedValues(staged.map((entry) => entry.key));
  // One statement for the set; keys are unique per operator, which a multi-row upsert requires.
  await db
    .insert(settings)
    .values(staged.map((entry) => ({ key: entry.key, value: entry.value, updatedAt: now })))
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`excluded.value`, updatedAt: now },
    });
  invalidateSettingsCache();

  const keys = staged.map((entry) => entry.key);
  const fallback = domainError("applyCaddyConfigFailed");
  let failure: Error | null = null;
  try {
    await applyCaddyConfig();
  } catch (cause) {
    // A non-Error, or caddy/index.ts's error with this very sentence: use the code so it translates.
    failure = cause instanceof Error && cause.message !== fallback.message ? cause : fallback;
  }
  // The managed crowdsec container is desired state, which no Caddy load carries.
  if (keys.includes("crowdsec")) {
    const { applyManagedServices } = await import("../agent/managed-services");
    await applyManagedServices();
  }
  // English: the revision row is history, not a message for one reader.
  const error = failure?.message ?? null;

  const [row] = await db
    .insert(settingsRevisions)
    .values({
      appliedBy: userId,
      appliedByName,
      summary: keys.join(", "),
      keys: JSON.stringify(keys),
      changes: JSON.stringify(
        Object.fromEntries(
          staged.map((entry): [string, RevisionChange] => [
            entry.key,
            { before: previous.get(entry.key) ?? null, after: entry.value },
          ]),
        ),
      ),
      outcome: error ? "failed" : "applied",
      error,
      appliedAt: now,
    })
    .returning({ id: settingsRevisions.id });

  const revision = row?.id ?? 0;
  await logAuditEvent({
    userId,
    action: "update",
    entityType: "settings",
    entityId: revision,
    summary: `Applied settings revision ${revision}`,
    // The values the revision records, as the history's own diff reads them.
    changes: diffAuditRecords(
      Object.fromEntries(
        staged.map((entry) => [entry.key, parseStored(previous.get(entry.key) ?? null)]),
      ),
      Object.fromEntries(staged.map((entry) => [entry.key, parseStored(entry.value)])),
    ),
  });
  return failure
    ? { ok: false, error: failure.message, cause: failure, revision }
    : { ok: true, revision };
}

function parseStored(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Newest first. */
export async function recentRevisions(limit = 3, offset = 0): Promise<RevisionRow[]> {
  const rows = await db
    .select({
      id: settingsRevisions.id,
      appliedByName: settingsRevisions.appliedByName,
      summary: settingsRevisions.summary,
      keys: settingsRevisions.keys,
      outcome: settingsRevisions.outcome,
      error: settingsRevisions.error,
      appliedAt: settingsRevisions.appliedAt,
      changes: settingsRevisions.changes,
    })
    .from(settingsRevisions)
    .orderBy(desc(settingsRevisions.id))
    .limit(limit)
    .offset(offset);

  return rows.map(({ changes, ...row }) => ({
    ...row,
    keys: parseRevisionKeys(row.keys),
    outcome: row.outcome === "failed" ? "failed" : "applied",
    recorded: parseRevisionChanges(changes) !== null,
  }));
}

/** Null for a row that predates the column, or one whose JSON cannot be read. */
export function parseRevisionChanges(raw: string | null): Map<string, RevisionChange> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const changes = new Map<string, RevisionChange>();
    for (const [key, value] of Object.entries(parsed)) {
      const { before, after } = (value ?? {}) as Record<string, unknown>;
      if (typeof after !== "string" || (before !== null && typeof before !== "string")) return null;
      changes.set(key, { before, after });
    }
    return changes;
  } catch {
    return null;
  }
}

/** An unreadable column yields no keys, and the sheet falls back to the stored summary. */
function parseRevisionKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}
