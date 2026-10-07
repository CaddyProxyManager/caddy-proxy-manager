/** One source for the staged bar and review sheet, so no two pages disagree on what is pending. */

import { isDemoMode } from "../demo/mode";
import db from "../db";
import { listStagedSettings } from "./staging";
import { recentRevisions } from "./apply";
import { renderConfigComparison } from "./apply";
import { diffConfigDocuments } from "./config-diff";
import { sectionForStorageKey } from "./section-keys";

export type StagedChange = {
  key: string;
  sectionId: string | null;
  label: string;
  /** Fields that differ from the stored blob; empty for a single value or a non-object. */
  fields: string[];
  stagedAt: string;
};

export type StagedView = {
  changes: StagedChange[];
  diff: ReturnType<typeof diffConfigDocuments>;
  revisions: Awaited<ReturnType<typeof recentRevisions>>;
  currentRevision: number | null;
  /** Every apply fails in the demo, which has no Caddy; the rail says so instead of "failed". */
  demoMode: boolean;
  /** The approval policy holds this set: applying it submits a change request instead. */
  approvalRequired: boolean;
};

function changedFields(storedValue: string | null, stagedValue: string): string[] {
  const parse = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const before = parse(storedValue);
  const after = parse(stagedValue);
  // Not an object blob: the key itself is the change.
  if (!after) return [];

  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...names]
    .filter((name) => JSON.stringify(before?.[name]) !== JSON.stringify(after[name]))
    .sort();
}

export async function stagedView(userId: number): Promise<StagedView> {
  const [staged, revisions] = await Promise.all([listStagedSettings(userId), recentRevisions(3)]);

  // Straight from the table: the read path would hand back the staged values.
  const storedRows = await db.query.settings.findMany();
  const stored = new Map(storedRows.map((row) => [row.key, row.value]));

  const changes: StagedChange[] = staged.map((entry) => {
    const known = sectionForStorageKey(entry.key);
    return {
      key: entry.key,
      sectionId: known?.id ?? null,
      // An unmapped key shows under its own name rather than silently disappearing.
      label: known?.label ?? entry.key,
      fields: changedFields(stored.get(entry.key) ?? null, entry.value),
      stagedAt: entry.stagedAt,
    };
  });

  // Rendering the config twice is only worth it when there is something to compare.
  let diff = diffConfigDocuments({}, {});
  if (changes.length > 0) {
    try {
      const { current, staged: pending } = await renderConfigComparison(userId);
      diff = diffConfigDocuments(current, pending);
    } catch (error) {
      // A throwing builder must not take the settings page down; the diff is just omitted.
      console.error("Failed to render the staged config diff:", error);
    }
  }

  let approvalRequired = false;
  if (staged.length > 0) {
    // Lazily: the approvals module reaches back into settings for what it applies.
    const { needsApproval } = await import("../approvals");
    approvalRequired = await needsApproval(
      { userId },
      {
        kind: "settingsApply",
        payload: { entries: staged.map(({ key, value }) => ({ key, value })) },
      },
    );
  }

  return {
    changes,
    diff,
    revisions,
    currentRevision: revisions[0]?.id ?? null,
    demoMode: isDemoMode(),
    approvalRequired,
  };
}

/** Just the keys, for marking tiles without paying for a config render. */
export async function stagedKeys(userId: number): Promise<Set<string>> {
  return new Set((await listStagedSettings(userId)).map((entry) => entry.key));
}
