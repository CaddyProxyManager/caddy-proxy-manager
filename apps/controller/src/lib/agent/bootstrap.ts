/**
 * Pairs the bundled agent through a token on the shared volume: reaching the volume already means
 * being inside the stack. On disk only while needed, since anything reading the volume could pair -
 * never after an operator unpaired the bundled agent. Remote agents use the six-letter code.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_BOOTSTRAP_FILE, AGENT_BOOTSTRAP_TOKEN_PATTERN } from "@cpm/shared";
import { and, eq } from "drizzle-orm";
import db from "../db";
import { agentPairingSecrets } from "../db/schema";
import { isDemoMode } from "../demo/mode";
import { findAgentRowByAgentId, listAgents } from "../models/agents";
import { clearSetting, getSetting, setSetting } from "../settings";

/** Long enough for a stack coming up together, or an agent redialling a rebuilt controller. */
export const BOOTSTRAP_TOKEN_TTL_MS = 30 * 60_000;

/** Pairing with a bootstrap token is what makes an agent the bundled one. */
const BUNDLED_AGENT_KEY = "agent_bootstrap_agent_id";
/** Set when an operator unpairs the bundled agent, so it does not pair itself straight back. */
const AUTO_PAIR_DISABLED_KEY = "agent_bootstrap_disabled";

/**
 * Only a token a controller wrote is accepted, whatever else lands on the volume. Its hash is
 * stored, so the bundled agent can redeem it through any replica.
 */
const SLOT = "bootstrap";

type IssuedToken = { hash: string; expiresAt: number; agentId: string | null };

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

async function issuedToken(): Promise<IssuedToken | null> {
  const [row] = await db
    .select({
      hash: agentPairingSecrets.secret,
      expiresAt: agentPairingSecrets.expiresAt,
      agentId: agentPairingSecrets.agentId,
    })
    .from(agentPairingSecrets)
    .where(eq(agentPairingSecrets.slot, SLOT))
    .limit(1);
  return row ?? null;
}

/** Named for the setting it first served, which every test rig points at a scratch directory. */
function dataDir(): string {
  return process.env.L4_PORTS_DIR || "/app/data";
}

export function bootstrapPath(): string {
  return join(dataDir(), AGENT_BOOTSTRAP_FILE);
}

function secureEquals(a: string, b: string): boolean {
  // timingSafeEqual throws on a length mismatch, itself an oracle for the token's length.
  const left = createHmac("sha256", "compare").update(Buffer.from(a, "utf8")).digest();
  const right = createHmac("sha256", "compare").update(Buffer.from(b, "utf8")).digest();
  return timingSafeEqual(left, right);
}

async function removeToken(): Promise<void> {
  await db.delete(agentPairingSecrets).where(eq(agentPairingSecrets.slot, SLOT));
  try {
    rmSync(bootstrapPath(), { force: true });
  } catch (error) {
    console.warn("[cpm] could not remove the agent bootstrap token:", error);
  }
}

/**
 * `agentId` binds it to one agent (a re-pair); null pairs only an agent never seen. 0640 for the
 * agent via the controller's group; chmodded again because writeFileSync's mode applies only on
 * create, and a 0600 file from a root-agent release would stay unreadable.
 */
export async function issueBootstrapToken(
  agentId: string | null,
  now = Date.now(),
): Promise<boolean> {
  // The bundled agent would pair and start a real Caddy.
  if (isDemoMode()) return false;
  const path = bootstrapPath();
  // Shaped so it cannot be confused with a typed code.
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, token, { encoding: "utf-8", mode: 0o640 });
    chmodSync(path, 0o640);
  } catch (error) {
    // No shared volume or a read-only mount: not an error, that deployment pairs with a code.
    console.warn(`[cpm] could not write the agent bootstrap token to ${path}:`, error);
    await db.delete(agentPairingSecrets).where(eq(agentPairingSecrets.slot, SLOT));
    return false;
  }
  const row = { secret: hashToken(token), expiresAt: now + BOOTSTRAP_TOKEN_TTL_MS, agentId };
  await db
    .insert(agentPairingSecrets)
    .values({ slot: SLOT, ...row })
    .onConflictDoUpdate({ target: agentPairingSecrets.slot, set: { ...row, failures: 0 } });
  return true;
}

export async function bundledAgentId(): Promise<string | null> {
  const value = await getSetting<string>(BUNDLED_AGENT_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function isBundledAgent(agentId: string): Promise<boolean> {
  return (await bundledAgentId()) === agentId;
}

export async function autoPairingDisabled(): Promise<boolean> {
  return (await getSetting<boolean>(AUTO_PAIR_DISABLED_KEY)) === true;
}

/** With no record of which agent is bundled, any paired agent counts as "already paired". */
async function wantsToken(): Promise<boolean> {
  if (await autoPairingDisabled()) return false;
  const bundled = await bundledAgentId();
  if (bundled) return (await findAgentRowByAgentId(bundled)) === null;
  return (await listAgents()).length === 0;
}

/** Startup: a token an operator bound to one agent is left alone, since that was asked for. */
export async function ensureBootstrapToken(now = Date.now()): Promise<boolean> {
  const issued = await issuedToken();
  if (!(await wantsToken())) {
    if (!issued?.agentId) await removeToken();
    return issued !== null && issued.agentId !== null && issued.expiresAt > now;
  }
  if (issued && issued.expiresAt > now) return true;
  return issueBootstrapToken(null, now);
}

/**
 * Deleting the row is the claim, so of two redemptions at once, on any replicas, one gets it. A
 * wrong guess leaves it, or anyone could keep the bundled agent from ever pairing.
 */
export async function redeemBootstrapToken(
  submitted: string,
  agentId: string,
  alreadyPaired: boolean,
  now = Date.now(),
): Promise<boolean> {
  const live = await issuedToken();
  if (!live) return false;
  if (live.expiresAt <= now) {
    await removeToken();
    return false;
  }
  if (!secureEquals(live.hash, hashToken(submitted.trim()))) return false;
  // Displacing an existing agent takes an operator's re-pair, which binds the token.
  if (live.agentId === null ? alreadyPaired : live.agentId !== agentId) return false;

  const claimed = await db
    .delete(agentPairingSecrets)
    .where(and(eq(agentPairingSecrets.slot, SLOT), eq(agentPairingSecrets.secret, live.hash)))
    .returning({ slot: agentPairingSecrets.slot });
  if (claimed.length === 0) return false;
  try {
    rmSync(bootstrapPath(), { force: true });
  } catch {
    // Another replica's volume, or gone already; a leftover file holds a dead token.
  }
  return true;
}

/** So the unpair and re-pair actions know which agent is bundled. */
export async function recordBundledAgent(agentId: string): Promise<void> {
  await setSetting(BUNDLED_AGENT_KEY, agentId);
}

/**
 * Unpairing the bundled agent turns auto-pairing off, or it would pair straight back. With no
 * record of which is bundled, any unpair counts - one click to undo.
 */
export async function forgetBootstrapAgent(agentId: string): Promise<void> {
  const bundled = await bundledAgentId();
  if (bundled !== null && bundled !== agentId) return;
  await setSetting(AUTO_PAIR_DISABLED_KEY, true);
  await removeToken();
}

/** Explicit, so it writes a token whatever is paired. */
export async function enableAutoPairing(now = Date.now()): Promise<boolean> {
  await clearSetting(AUTO_PAIR_DISABLED_KEY);
  return issueBootstrapToken(null, now);
}

/** Tells a bootstrap token from a typed six-letter code. */
export function looksLikeBootstrapToken(value: string): boolean {
  return AGENT_BOOTSTRAP_TOKEN_PATTERN.test(value.trim());
}

/** Test seam: forgets the token without touching the disk. */
export async function resetBootstrapState(): Promise<void> {
  await db.delete(agentPairingSecrets).where(eq(agentPairingSecrets.slot, SLOT));
}
