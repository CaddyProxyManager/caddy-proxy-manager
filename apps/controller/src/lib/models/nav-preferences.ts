import { eq } from "drizzle-orm";
import db, { nowIso } from "../db";
import { settings } from "../db/schema";
import { type DestinationId, isDestinationId, MORE_DRAWER_SLOTS } from "../nav/destinations";

/**
 * Written to the table directly, not via setSetting, which stages writes for Review & apply: a
 * personal choice must not appear in anyone's staged diff. The row's presence means "customized".
 */
const keyFor = (userId: number) => `nav:more_drawer:${userId}`;

export async function getMoreDrawerPins(userId: number): Promise<DestinationId[] | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, keyFor(userId)))
    .limit(1);
  if (!row) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // Unreadable reads as never chosen; throwing would take the whole dashboard layout down.
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(isDestinationId).slice(0, MORE_DRAWER_SLOTS);
}

export async function setMoreDrawerPins(
  userId: number,
  ids: readonly DestinationId[],
): Promise<void> {
  const value = JSON.stringify([...new Set(ids)].slice(0, MORE_DRAWER_SLOTS));
  const now = nowIso();
  await db
    .insert(settings)
    .values({ key: keyFor(userId), value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}
