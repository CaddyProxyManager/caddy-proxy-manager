import { eq, like } from "drizzle-orm";
import db, { nowIso } from "../db";
import { settings } from "../db/schema";
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "../notifications/events";

/**
 * What one administrator is told, and how. Written to the table directly, as the nav pins are: a
 * personal choice must not appear in anyone's staged diff. No row means never chosen.
 */
export type NotificationPreferences = {
  /** Null until chosen: the default depends on the Recipients list (see audience.ts). */
  email: boolean | null;
  push: boolean;
  /** Categories this administrator turned off for themselves; the rest follow Settings. */
  muted: NotificationCategory[];
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  email: null,
  push: true,
  muted: [],
};

const PREFIX = "notifications:prefs:";
const keyFor = (userId: number) => `${PREFIX}${userId}`;

function isCategory(value: unknown): value is NotificationCategory {
  return NOTIFICATION_CATEGORIES.includes(value as NotificationCategory);
}

/** A hand-edited or older row reads as far as it goes, never as an error. */
export function parseNotificationPreferences(raw: string | null): NotificationPreferences {
  if (!raw) return DEFAULT_NOTIFICATION_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }
  const stored = (parsed ?? {}) as { email?: unknown; push?: unknown; muted?: unknown };
  return {
    email: typeof stored.email === "boolean" ? stored.email : null,
    push: typeof stored.push === "boolean" ? stored.push : true,
    muted: Array.isArray(stored.muted) ? [...new Set(stored.muted.filter(isCategory))] : [],
  };
}

export async function getNotificationPreferences(userId: number): Promise<NotificationPreferences> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, keyFor(userId)))
    .limit(1);
  return parseNotificationPreferences(row?.value ?? null);
}

/** Every stored choice at once, for a send; a user absent from the map never chose. */
export async function allNotificationPreferences(): Promise<Map<number, NotificationPreferences>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, `${PREFIX}%`));
  const result = new Map<number, NotificationPreferences>();
  for (const row of rows) {
    const userId = Number(row.key.slice(PREFIX.length));
    if (Number.isInteger(userId)) result.set(userId, parseNotificationPreferences(row.value));
  }
  return result;
}

export async function setNotificationPreferences(
  userId: number,
  preferences: { email: boolean; push: boolean; muted: readonly string[] },
): Promise<void> {
  const value = JSON.stringify({
    email: preferences.email,
    push: preferences.push,
    muted: [...new Set(preferences.muted.filter(isCategory))],
  });
  const now = nowIso();
  await db
    .insert(settings)
    .values({ key: keyFor(userId), value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}
