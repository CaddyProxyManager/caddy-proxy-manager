/**
 * Encrypts DNS credentials older releases left in plaintext: the REST API stored the dns_provider
 * group as sent, and the legacy Cloudflare token predates encryption. Revision history holds the
 * same values, and restoring a revision would write them back, so it is covered too.
 */
import { eq, like, or } from "drizzle-orm";
import db from "../db";
import { settings, settingsRevisions } from "../db/schema";
import { encryptDnsProviderSettingCredentials } from "../dns/provider-credentials";
import { encryptSecret, isEncryptedSecret } from "../secrets";

function encryptCloudflareToken<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { apiToken } = value as { apiToken?: unknown };
  if (typeof apiToken !== "string" || !apiToken || isEncryptedSecret(apiToken)) return value;
  return { ...value, apiToken: encryptSecret(apiToken) };
}

const ENCRYPTORS: Record<string, (value: unknown) => unknown> = {
  dns_provider: encryptDnsProviderSettingCredentials,
  cloudflare: encryptCloudflareToken,
};

/** The stored JSON text with its credentials encrypted, or null when nothing changed. */
function encryptJsonText(key: string, raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const before = JSON.stringify(parsed);
  const after = JSON.stringify(ENCRYPTORS[key](parsed));
  return after === before ? null : after;
}

/** Idempotent. Returns how many rows were rewritten. */
export async function encryptPlaintextDnsCredentials(): Promise<number> {
  let rewritten = 0;

  for (const key of Object.keys(ENCRYPTORS)) {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key));
    const next = row && encryptJsonText(key, row.value);
    if (!next) continue;
    await db.update(settings).set({ value: next }).where(eq(settings.key, key));
    rewritten += 1;
  }

  const revisions = await db
    .select({ id: settingsRevisions.id, changes: settingsRevisions.changes })
    .from(settingsRevisions)
    .where(
      or(...Object.keys(ENCRYPTORS).map((key) => like(settingsRevisions.changes, `%"${key}"%`))),
    );
  for (const revision of revisions) {
    let changes: Record<string, { before: string | null; after: string }>;
    try {
      changes = JSON.parse(revision.changes ?? "null");
    } catch {
      continue;
    }
    if (!changes || typeof changes !== "object") continue;
    let changed = false;
    for (const key of Object.keys(ENCRYPTORS)) {
      const change = changes[key];
      if (!change || typeof change !== "object") continue;
      for (const side of ["before", "after"] as const) {
        const raw = change[side];
        const next = typeof raw === "string" ? encryptJsonText(key, raw) : null;
        if (next) {
          change[side] = next;
          changed = true;
        }
      }
    }
    if (!changed) continue;
    await db
      .update(settingsRevisions)
      .set({ changes: JSON.stringify(changes) })
      .where(eq(settingsRevisions.id, revision.id));
    rewritten += 1;
  }

  return rewritten;
}
