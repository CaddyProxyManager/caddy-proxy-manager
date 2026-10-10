/**
 * One-time pairing codes. The live code pairs a new agent; a re-pair code replaces one existing
 * agent's secret and nothing else. Stored encrypted, so a code one replica shows redeems on any;
 * the TTL retires one, as a restart once did.
 */

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS } from "@cpm/shared";
import { and, eq, like, lte, or, sql } from "drizzle-orm";
import { resetSharedWindows, sharedWindowSpent, takeFromSharedWindow } from "../auth/rate-limit";
import db from "../db";
import { agentPairingSecrets } from "../db/schema";
import { decryptSecret, encryptSecret } from "../secrets";
import { domainError } from "../errors/domain-error";

export type PairingCode = { code: string; expiresAt: number };

/**
 * Across all callers: 200 guesses at 24^6 (about 1.9e8) is roughly 1 in 950,000 per code, while
 * one client, held to 5 a minute, cannot burn a code by itself.
 */
const MAX_FAILURES_PER_CODE = 200;

const MAX_FAILURES_PER_CLIENT = 5;
const CLIENT_WINDOW_MS = 60_000;
const CLIENT_WINDOW_PREFIX = "pair-client:";

const table = agentPairingSecrets;
const LIVE_SLOT = "code";
const REPAIR_PREFIX = "repair:";
/** Keyed by the agentId it may re-pair. */
const repairSlot = (agentId: string) => `${REPAIR_PREFIX}${agentId}`;

function secureEquals(a: string, b: string): boolean {
  const left = createHmac("sha256", "compare").update(Buffer.from(a, "utf8")).digest();
  const right = createHmac("sha256", "compare").update(Buffer.from(b, "utf8")).digest();
  return timingSafeEqual(left, right);
}

function mintCode(): string {
  return Array.from(
    { length: PAIRING_CODE_LENGTH },
    () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)],
  ).join("");
}

type Stored = PairingCode & { secret: string };

async function read(slot: string): Promise<Stored | null> {
  const [row] = await db
    .select({ secret: table.secret, expiresAt: table.expiresAt })
    .from(table)
    .where(eq(table.slot, slot))
    .limit(1);
  if (!row) return null;
  try {
    return { code: decryptSecret(row.secret), expiresAt: row.expiresAt, secret: row.secret };
  } catch {
    // Under a SESSION_SECRET no key opens any more: as good as expired.
    await db.delete(table).where(sameCode(slot, row.secret));
    return null;
  }
}

/** Against the row as read, so a code replaced meanwhile is never the one burned or counted. */
function sameCode(slot: string, secret: string) {
  return and(eq(table.slot, slot), eq(table.secret, secret));
}

/** Two replicas asking at once agree on one: whichever insert lands, both read it back. */
export async function ensurePairingCode(now = Date.now()): Promise<PairingCode> {
  const live = await read(LIVE_SLOT);
  if (live && live.expiresAt > now) return { code: live.code, expiresAt: live.expiresAt };
  await db
    .insert(table)
    .values({
      slot: LIVE_SLOT,
      secret: encryptSecret(mintCode()),
      expiresAt: now + PAIRING_CODE_TTL_MS,
    })
    .onConflictDoUpdate({
      target: table.slot,
      set: { secret: sql`excluded.secret`, expiresAt: sql`excluded."expiresAt"`, failures: 0 },
      setWhere: lte(table.expiresAt, now),
    });
  const stored = await read(LIVE_SLOT);
  if (!stored) throw domainError("pairingCodeNotStored");
  return { code: stored.code, expiresAt: stored.expiresAt };
}

export async function revokePairingCode(): Promise<void> {
  await db.delete(table).where(eq(table.slot, LIVE_SLOT));
}

/** Replaces any earlier code for this agent. */
export async function mintRepairCode(agentId: string, now = Date.now()): Promise<PairingCode> {
  const code = mintCode();
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  const secret = encryptSecret(code);
  await db
    .insert(table)
    .values({ slot: repairSlot(agentId), secret, expiresAt })
    .onConflictDoUpdate({ target: table.slot, set: { secret, expiresAt, failures: 0 } });
  return { code, expiresAt };
}

export async function revokeRepairCode(agentId: string): Promise<void> {
  await db.delete(table).where(eq(table.slot, repairSlot(agentId)));
}

export type RedeemResult = { ok: true } | { ok: false; error: string };

const EXPIRED: RedeemResult = {
  ok: false,
  error: "That pairing code has expired. Generate a new one.",
};

/**
 * Burns the code on success, unless `keep` (the preview). A wrong guess costs the budget either
 * way, so previewing is no cheaper a way to guess.
 */
async function redeem(
  slot: string,
  live: Stored | null,
  submitted: string,
  now: number,
  keep = false,
): Promise<RedeemResult> {
  if (!live) return EXPIRED;
  if (live.expiresAt <= now) {
    await db.delete(table).where(sameCode(slot, live.secret));
    return EXPIRED;
  }

  if (!secureEquals(live.code, submitted.trim().toUpperCase())) {
    const [counted] = await db
      .update(table)
      .set({ failures: sql`${table.failures} + 1` })
      .where(sameCode(slot, live.secret))
      .returning({ failures: table.failures });
    if (counted && counted.failures >= MAX_FAILURES_PER_CODE) {
      await db.delete(table).where(sameCode(slot, live.secret));
    }
    return { ok: false, error: "That pairing code is not valid." };
  }

  if (keep) return { ok: true };
  // The delete is the claim: of two redemptions at once, only one removes the row.
  const burned = await db
    .delete(table)
    .where(sameCode(slot, live.secret))
    .returning({ slot: table.slot });
  return burned.length > 0 ? { ok: true } : EXPIRED;
}

export async function redeemPairingCode(
  submitted: string,
  now = Date.now(),
): Promise<RedeemResult> {
  return redeem(LIVE_SLOT, await read(LIVE_SLOT), submitted, now);
}

export async function checkPairingCode(submitted: string, now = Date.now()): Promise<RedeemResult> {
  return redeem(LIVE_SLOT, await read(LIVE_SLOT), submitted, now, true);
}

export async function checkRepairCode(
  agentId: string,
  submitted: string,
  now = Date.now(),
): Promise<RedeemResult> {
  const live = await read(repairSlot(agentId));
  if (!live) return redeemRepairCode(agentId, submitted, now);
  return redeem(repairSlot(agentId), live, submitted, now, true);
}

/** The live code never re-pairs anyone. */
export async function redeemRepairCode(
  agentId: string,
  submitted: string,
  now = Date.now(),
): Promise<RedeemResult> {
  const live = await read(repairSlot(agentId));
  if (!live) {
    return {
      ok: false,
      error:
        "This agent is already paired. Use Re-pair on its row in Settings → Agent to get a code for it.",
    };
  }
  return redeem(repairSlot(agentId), live, submitted, now);
}

/** Security housekeeping, on the leader. */
export async function pruneExpiredPairingSecrets(now = Date.now()): Promise<void> {
  await db.delete(table).where(lte(table.expiresAt, now));
}

// ─── Per-client throttle ─────────────────────────────────────────────────────

export function clientThrottled(client: string, now = Date.now()): Promise<boolean> {
  return sharedWindowSpent(`${CLIENT_WINDOW_PREFIX}${client}`, MAX_FAILURES_PER_CLIENT, now);
}

/** Counted only on a wrong guess, and checked before the next one reaches a code's own budget. */
export async function recordFailedGuess(client: string, now = Date.now()): Promise<void> {
  await takeFromSharedWindow(
    `${CLIENT_WINDOW_PREFIX}${client}`,
    MAX_FAILURES_PER_CLIENT,
    CLIENT_WINDOW_MS,
    now,
  );
}

/** Test seam. */
export async function resetPairingCodes(): Promise<void> {
  await db
    .delete(table)
    .where(or(eq(table.slot, LIVE_SLOT), like(table.slot, `${REPAIR_PREFIX}%`)));
  await resetSharedWindows(CLIENT_WINDOW_PREFIX);
}
