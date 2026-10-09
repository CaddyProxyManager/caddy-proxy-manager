/**
 * Needs attention in the server log: each item once when it appears, once when it clears. A
 * notification watcher, so only the leader logs, and a new leader lists everything open again.
 */

import { createTranslator } from "next-intl";
import messages from "../../../messages/en.json";
import { systemAccess } from "../users/permissions";
import { attentionErrorText } from "./error-text";
import {
  type AttentionCode,
  type AttentionItem,
  type AttentionList,
  type AttentionProviderId,
  attentionMessageValues,
} from "./types";

const EVERY_MS = 60_000;

type Seen = { code: AttentionCode; provider: AttentionProviderId };

let lastRun = 0;
let seen: Map<string, Seen> | null = null;

type DynamicTranslate = (key: string, values?: Record<string, string | number | Date>) => string;

/** English, as the rest of the log is. */
const tRoot = createTranslator({ locale: "en", messages });
const translate = tRoot as unknown as DynamicTranslate;

function itemText(item: AttentionItem): string {
  const values = {
    ...attentionMessageValues(item),
    ...(item.errors?.length && { error: attentionErrorText(tRoot, item.errors) }),
  };
  return `${translate(`attention.items.${item.code}.title`, values)} - ${translate(
    `attention.items.${item.code}.detail`,
    values,
  )}`;
}

/** Logs what changed since the previous list; returns what is open now. */
export function logAttentionChanges(
  list: AttentionList,
  previous: Map<string, Seen> | null,
  acknowledged: (item: AttentionItem) => boolean = () => false,
): Map<string, Seen> {
  const next = new Map<string, Seen>();
  for (const item of list.items) {
    next.set(item.id, { code: item.code, provider: item.provider });
    if (previous?.get(item.id)?.code === item.code) continue;
    const line = `[attention] ${item.severity}: ${itemText(item)} (${item.id})${
      acknowledged(item) ? " [acknowledged]" : ""
    }`;
    if (item.severity === "info") console.log(line);
    else console.warn(line);
  }
  for (const [id, was] of previous ?? []) {
    if (next.has(id)) continue;
    // Missing, not cleared: its provider did not finish, or it fell past the cap.
    if (list.skipped.includes(was.provider) || list.truncated > 0) {
      next.set(id, was);
      continue;
    }
    console.log(`[attention] cleared: ${was.code} (${id})`);
  }
  return next;
}

/** A notification watcher: once a minute, whatever the tick. */
export async function watchAttentionLog(now: number): Promise<void> {
  if (now - lastRun < EVERY_MS) return;
  lastRun = now;
  const [{ collectAttention }, { getAcknowledgements, isAcknowledged, pruneAcknowledgements }] =
    await Promise.all([import("./index"), import("./acknowledged")]);
  const list = await collectAttention(systemAccess(), { now });
  const acknowledgements = await getAcknowledgements();
  seen = logAttentionChanges(list, seen, (item) => isAcknowledged(acknowledgements, item));
  await pruneAcknowledgements(list);
}
