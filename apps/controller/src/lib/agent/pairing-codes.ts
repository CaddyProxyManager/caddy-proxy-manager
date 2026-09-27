/**
 * One-time pairing codes. The live code pairs a new agent; a re-pair code replaces one existing
 * agent's secret and nothing else. In memory only: a code must not outlive a restart, which is
 * exactly when an operator comes back for a fresh one.
 */

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS } from "@cpm/shared";
import { resetWindows, takeFromWindow, windowSpent } from "../rate-limit";

export type PairingCode = { code: string; expiresAt: number };

/**
 * Across all callers: 200 guesses at 24^6 (about 1.9e8) is roughly 1 in 950,000 per code, while
 * one client, held to 5 a minute, cannot burn a code by itself.
 */
const MAX_FAILURES_PER_CODE = 200;

const MAX_FAILURES_PER_CLIENT = 5;
const CLIENT_WINDOW_MS = 60_000;
/** Its table is bounded against a caller rotating addresses. */
const CLIENT_WINDOW_PREFIX = "pair-client:";

type LiveCode = PairingCode & { failures: number };

let current: LiveCode | null = null;
/** Keyed by the agentId each one may re-pair. */
const repairCodes = new Map<string, LiveCode>();

function secureEquals(a: string, b: string): boolean {
  const left = createHmac("sha256", "compare").update(Buffer.from(a, "utf8")).digest();
  const right = createHmac("sha256", "compare").update(Buffer.from(b, "utf8")).digest();
  return timingSafeEqual(left, right);
}

function mint(now: number): LiveCode {
  return {
    code: Array.from(
      { length: PAIRING_CODE_LENGTH },
      () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)],
    ).join(""),
    expiresAt: now + PAIRING_CODE_TTL_MS,
    failures: 0,
  };
}

export function ensurePairingCode(now = Date.now()): PairingCode {
  if (!current || current.expiresAt <= now) current = mint(now);
  return { code: current.code, expiresAt: current.expiresAt };
}

export function revokePairingCode(): void {
  current = null;
}

/** Replaces any earlier code for this agent. */
export function mintRepairCode(agentId: string, now = Date.now()): PairingCode {
  const live = mint(now);
  repairCodes.set(agentId, live);
  return { code: live.code, expiresAt: live.expiresAt };
}

export function revokeRepairCode(agentId: string): void {
  repairCodes.delete(agentId);
}

export type RedeemResult = { ok: true } | { ok: false; error: string };

/**
 * Burns the code on success, unless `keep` (the preview). A wrong guess costs the budget either
 * way, so previewing is no cheaper a way to guess.
 */
function redeem(
  live: LiveCode | null | undefined,
  submitted: string,
  now: number,
  discard: () => void,
  keep = false,
): RedeemResult {
  const expired = {
    ok: false as const,
    error: "That pairing code has expired. Generate a new one.",
  };
  if (!live) return expired;
  if (live.expiresAt <= now) {
    discard();
    return expired;
  }

  if (!secureEquals(live.code, submitted.trim().toUpperCase())) {
    live.failures += 1;
    if (live.failures >= MAX_FAILURES_PER_CODE) discard();
    return { ok: false, error: "That pairing code is not valid." };
  }

  if (!keep) discard();
  return { ok: true };
}

export function redeemPairingCode(submitted: string, now = Date.now()): RedeemResult {
  return redeem(current, submitted, now, () => {
    current = null;
  });
}

export function checkPairingCode(submitted: string, now = Date.now()): RedeemResult {
  return redeem(
    current,
    submitted,
    now,
    () => {
      current = null;
    },
    true,
  );
}

export function checkRepairCode(
  agentId: string,
  submitted: string,
  now = Date.now(),
): RedeemResult {
  const live = repairCodes.get(agentId);
  if (!live) return redeemRepairCode(agentId, submitted, now);
  return redeem(
    live,
    submitted,
    now,
    () => {
      repairCodes.delete(agentId);
    },
    true,
  );
}

/** The live code never re-pairs anyone. */
export function redeemRepairCode(
  agentId: string,
  submitted: string,
  now = Date.now(),
): RedeemResult {
  const live = repairCodes.get(agentId);
  if (!live) {
    return {
      ok: false,
      error:
        "This agent is already paired. Use Re-pair on its row in Settings → Agent to get a code for it.",
    };
  }
  return redeem(live, submitted, now, () => {
    repairCodes.delete(agentId);
  });
}

// ─── Per-client throttle ─────────────────────────────────────────────────────

export function clientThrottled(client: string, now = Date.now()): boolean {
  return windowSpent(`${CLIENT_WINDOW_PREFIX}${client}`, MAX_FAILURES_PER_CLIENT, now);
}

/** Counted only on a wrong guess, and checked before the next one reaches a code's own budget. */
export function recordFailedGuess(client: string, now = Date.now()): void {
  takeFromWindow(
    `${CLIENT_WINDOW_PREFIX}${client}`,
    MAX_FAILURES_PER_CLIENT,
    CLIENT_WINDOW_MS,
    now,
  );
}

/** Test seam. */
export function resetPairingCodes(): void {
  current = null;
  repairCodes.clear();
  resetWindows(CLIENT_WINDOW_PREFIX);
}
