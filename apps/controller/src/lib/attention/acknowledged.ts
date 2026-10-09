/**
 * Needs attention items an administrator has acknowledged, hidden from the overview. Keyed by id
 * and code, since an id names the condition: `certificate:12` going from expiring to expired comes
 * back. One settings row per instance, outside staging, as the setup checklist's is.
 */

import { logAuditEvent } from "../audit";
import { getSetting, setSetting } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";
import { ATTENTION_CODES, type AttentionCode, type AttentionList } from "./types";

const STATE_KEY = "attention_acknowledged";
const MAX_ID_LENGTH = 300;

export type Acknowledgement = { code: AttentionCode; at: string; by: number };
export type Acknowledgements = Record<string, Acknowledgement>;

function isCode(value: unknown): value is AttentionCode {
  return (ATTENTION_CODES as readonly unknown[]).includes(value);
}

export function normalizeAcknowledgements(raw: unknown): Acknowledgements {
  if (!raw || typeof raw !== "object") return {};
  const state: Acknowledgements = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    if (!isCode(value.code)) continue;
    state[id] = {
      code: value.code,
      at: typeof value.at === "string" ? value.at : "",
      by: typeof value.by === "number" ? value.by : 0,
    };
  }
  return state;
}

export async function getAcknowledgements(): Promise<Acknowledgements> {
  return normalizeAcknowledgements(await outsideStagingScope(() => getSetting<unknown>(STATE_KEY)));
}

async function saveAcknowledgements(state: Acknowledgements): Promise<void> {
  await outsideStagingScope(() => setSetting(STATE_KEY, state));
}

export function isAcknowledged(
  state: Acknowledgements,
  item: { id: string; code: AttentionCode },
): boolean {
  return Object.hasOwn(state, item.id) && state[item.id].code === item.code;
}

/** The list without what has been acknowledged, and how many that hid. */
export function withoutAcknowledged(
  list: AttentionList,
  state: Acknowledgements,
): { list: AttentionList; acknowledged: number } {
  const items = list.items.filter((item) => !isAcknowledged(state, item));
  return { list: { ...list, items }, acknowledged: list.items.length - items.length };
}

/** False for an id or code that cannot be one; acknowledging what is not listed is harmless. */
export async function acknowledgeAttention(
  item: { id: string; code: string },
  actorUserId: number,
): Promise<boolean> {
  if (!isCode(item.code) || !item.id || item.id.length > MAX_ID_LENGTH) return false;
  const state = await getAcknowledgements();
  state[item.id] = { code: item.code, at: new Date().toISOString(), by: actorUserId };
  await saveAcknowledgements(state);
  console.log(`[attention] acknowledged ${item.code} (${item.id}) by user ${actorUserId}`);
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "attention",
    summary: `Acknowledged ${item.code} (${item.id}) in Needs attention`,
  });
  return true;
}

/**
 * Forgets acknowledgements whose condition has cleared, so a recurrence is shown again. Only from
 * a complete list: a skipped provider or a truncated tail hides items that are still there.
 */
export async function pruneAcknowledgements(list: AttentionList): Promise<void> {
  if (list.skipped.length > 0 || list.truncated > 0) return;
  const state = await getAcknowledgements();
  const current = new Set(list.items.map((item) => `${item.id}\n${item.code}`));
  const kept = Object.fromEntries(
    Object.entries(state).filter(([id, ack]) => current.has(`${id}\n${ack.code}`)),
  );
  if (Object.keys(kept).length !== Object.keys(state).length) await saveAcknowledgements(kept);
}
