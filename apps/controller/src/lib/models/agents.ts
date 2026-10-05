/**
 * A row is a standing grant - its secret can recreate containers on that host - so the secret is
 * encrypted at rest, never leaves the server, and a row exists only through a pairing exchange.
 */

import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import db, { nowIso } from "../db";
import { agents } from "../db/schema";
import { decryptSecret, encryptSecret } from "../secrets";
import { type CaddyBuildSettings, getSetting, setSetting } from "../settings";

const CONTROLLER_ID_KEY = "controller_id";

export type PairedAgent = {
  id: number;
  name: string;
  agentId: string;
  enabled: boolean;
  /** Its own Caddy build selection rather than the fleet default. */
  hasOwnBuildSettings: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Server-side only. */
export type AgentCredentials = PairedAgent & { secret: string };

type Row = typeof agents.$inferSelect;

/** Everything leaving this module goes through here, to strip the secret. */
function toView(row: Row): PairedAgent {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agentId,
    enabled: row.enabled,
    hasOwnBuildSettings: row.buildSettings !== null,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Agents key their secrets on it, so a new id would force re-pairing every agent by hand. */
export async function getControllerId(): Promise<string> {
  const existing = await getSetting<string>(CONTROLLER_ID_KEY);
  if (typeof existing === "string" && existing.length > 0) return existing;

  const id = randomBytes(16).toString("hex");
  await setSetting(CONTROLLER_ID_KEY, id);
  return id;
}

export async function listAgents(): Promise<PairedAgent[]> {
  const rows = await db.select().from(agents).orderBy(agents.id);
  return rows.map(toView);
}

/**
 * Null when already paired. Never an upsert, or any code could displace a live agent or
 * re-enable a disabled one; `replaceAgentSecret` needs a credential minted for that agent.
 */
export async function insertPairedAgent(input: {
  name: string;
  agentId: string;
  secret: string;
}): Promise<PairedAgent | null> {
  const now = nowIso();
  const [row] = await db
    .insert(agents)
    .values({
      name: input.name,
      agentId: input.agentId,
      secret: encryptSecret(input.secret),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: agents.agentId })
    .returning();
  return row ? toView(row) : null;
}

/** Leaves `enabled` and the name alone: re-pairing restores a credential, not past decisions. */
export async function replaceAgentSecret(input: {
  agentId: string;
  secret: string;
}): Promise<void> {
  await db
    .update(agents)
    .set({ secret: encryptSecret(input.secret), updatedAt: nowIso() })
    .where(eq(agents.agentId, input.agentId));
}

/** Who an agentId belongs to, disabled or not, without its secret. */
export async function findAgentRowByAgentId(agentId: string): Promise<PairedAgent | null> {
  const [row] = await db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
  return row ? toView(row) : null;
}

export async function findAgentById(id: number): Promise<PairedAgent | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ? toView(row) : null;
}

/** Secret included; null if unknown. */
export async function findAgentByAgentId(agentId: string): Promise<AgentCredentials | null> {
  const [row] = await db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
  if (!row?.enabled) return null;
  try {
    return { ...toView(row), secret: decryptSecret(row.secret) };
  } catch (error) {
    // Encrypted under an old SESSION_SECRET; only re-pairing fixes it, so treat it as unknown.
    console.error(`Failed to decrypt the secret for agent "${row.name}":`, error);
    return null;
  }
}

/** What the registry keeps instead of a secret, to tell later whether it still matches. */
export function agentCredentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Closes the streams the agents table no longer vouches for: gone, disabled, a different row, or
 * a different secret. Run after anything that rewrites the table, before config is pushed.
 */
export async function reconcileAgentConnections(): Promise<string[]> {
  const { reconcileConnections } = await import("../agent/registry");
  const rows = new Map<string, { id: number; fingerprint: string | null }>();
  for (const row of await db.select().from(agents)) {
    if (!row.enabled) continue;
    let fingerprint: string | null = null;
    try {
      fingerprint = agentCredentialFingerprint(decryptSecret(row.secret));
    } catch {
      // Unreadable under this SESSION_SECRET: nothing can authenticate as it.
    }
    rows.set(row.agentId, { id: row.id, fingerprint });
  }
  return reconcileConnections((connection) => {
    const row = rows.get(connection.agentId);
    if (!row || row.id !== connection.agentRowId) return false;
    return connection.credential === undefined || connection.credential === row.fingerprint;
  });
}

/** Operator-facing only: routing is by agentId, which this never touches. */
export async function renameAgent(id: number, name: string): Promise<void> {
  await db
    .update(agents)
    .set({ name: name.trim().slice(0, 128), updatedAt: nowIso() })
    .where(eq(agents.id, id));
}

/** Returns the agentId so the caller can drop that agent's stream. */
export async function deleteAgent(id: number): Promise<string | null> {
  const [row] = await db
    .delete(agents)
    .where(eq(agents.id, id))
    .returning({ agentId: agents.agentId });
  return row?.agentId ?? null;
}

/** Best-effort: it runs on every status report, and a failed timestamp must not fail the call. */
export async function recordAgentContact(id: number): Promise<void> {
  try {
    await db
      .update(agents)
      .set({ lastSeenAt: nowIso(), updatedAt: nowIso() })
      .where(eq(agents.id, id));
  } catch (error) {
    console.warn("Failed to record agent contact:", error);
  }
}

// ─── Per-agent Caddy build settings ──────────────────────────────────────────

/** Null follows the fleet default - as does hand-edited, unparseable JSON, rather than throwing. */
export async function getAgentBuildSettings(id: number): Promise<CaddyBuildSettings | null> {
  const [row] = await db
    .select({ raw: agents.buildSettings })
    .from(agents)
    .where(eq(agents.id, id));
  if (!row?.raw) return null;
  try {
    return JSON.parse(row.raw) as CaddyBuildSettings;
  } catch (error) {
    // Not interpolated: console.warn's first argument is a format string, and the id is untrusted.
    console.warn("[cpm] agent has unparseable build settings; using the fleet default:", id, error);
    return null;
  }
}

/** Every agent's own selection, keyed by row id. Absent means "follows the fleet default". */
export async function getAllAgentBuildSettings(): Promise<Map<number, CaddyBuildSettings>> {
  const rows = await db.select({ id: agents.id, raw: agents.buildSettings }).from(agents);
  const result = new Map<number, CaddyBuildSettings>();
  for (const row of rows) {
    if (!row.raw) continue;
    try {
      result.set(row.id, JSON.parse(row.raw) as CaddyBuildSettings);
    } catch {
      // Falls through to the fleet default for this one agent.
    }
  }
  return result;
}

/** Null puts it back on the fleet default. */
export async function setAgentBuildSettings(
  id: number,
  settings: CaddyBuildSettings | null,
): Promise<void> {
  await db
    .update(agents)
    .set({
      buildSettings: settings === null ? null : JSON.stringify(settings),
      updatedAt: nowIso(),
    })
    .where(eq(agents.id, id));
}
