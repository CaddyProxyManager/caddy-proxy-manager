/**
 * Lifts values an older release stored in JSON `settings` blobs into registry keys, so an
 * operator's UI choice survives and consumers read one place.
 */
import { eq } from "drizzle-orm";
import db from "../db";
import { settings } from "../db/schema";
import { gravatarEnabled, requirePasswordChangeOnLegacyHash } from "../settings/registry";
import { saveSettings } from "../settings/resolve";

type Carryover = {
  blobKey: string;
  field: string;
  settingKey: string;
};

const CARRYOVERS: Carryover[] = [
  { blobKey: "avatars", field: "gravatarEnabled", settingKey: gravatarEnabled.key },
  {
    blobKey: "password_policy",
    field: "requireChangeOnLegacyHash",
    settingKey: requirePasswordChangeOnLegacyHash.key,
  },
];

export type CarryoverResult = { settingKey: string; value: boolean };

/** Only writes what it finds: inventing a value would pin a default that was free to change. */
export async function carryOverBlobSettings(): Promise<CarryoverResult[]> {
  const applied: CarryoverResult[] = [];

  for (const carryover of CARRYOVERS) {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, carryover.blobKey))
      .limit(1);
    if (!row) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      console.warn(`Migration: ignoring unparseable ${carryover.blobKey} setting`);
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) continue;
    const value = (parsed as Record<string, unknown>)[carryover.field];
    if (typeof value !== "boolean") continue;

    await saveSettings({ [carryover.settingKey]: value });
    applied.push({ settingKey: carryover.settingKey, value });
  }

  return applied;
}
