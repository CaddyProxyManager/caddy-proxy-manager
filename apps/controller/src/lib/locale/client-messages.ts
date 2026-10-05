/**
 * What the browser is sent of the catalog: all of it but what only the server renders, since one
 * provider serves every page and a missing key renders raw. Server components keep the full catalog
 * through `getTranslations`. tests/unit/i18n/client-messages.test.ts fails when a client module
 * reaches one of these.
 */
import type { AbstractIntlMessages } from "next-intl";

export const SERVER_ONLY_MESSAGES = [
  // Rendered into mail by the notifier.
  "email",
  // Rendered by lib/audit/summary.ts, which only server pages import.
  "auditLog.summaries",
  // Answered by the setup routes as JSON.
  "setup.migrateErrors",
] as const;

const picked = new WeakMap<AbstractIntlMessages, AbstractIntlMessages>();

function without(messages: AbstractIntlMessages, path: readonly string[]): AbstractIntlMessages {
  const [head, ...rest] = path;
  if (!(head in messages)) return messages;
  const copy = { ...messages };
  const child = copy[head];
  if (rest.length === 0) delete copy[head];
  else if (child && typeof child === "object") copy[head] = without(child, rest);
  return copy;
}

/** Per catalog object, so each locale is trimmed once per process. */
export function clientMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  const hit = picked.get(messages);
  if (hit) return hit;
  let trimmed = messages;
  for (const path of SERVER_ONLY_MESSAGES) trimmed = without(trimmed, path.split("."));
  picked.set(messages, trimmed);
  return trimmed;
}
