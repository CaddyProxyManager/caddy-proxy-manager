/**
 * Verifies a request came from a paired agent. Both sides sign the same canonical string with the
 * same symmetric secret; inverting the dial direction changed who proves itself, not the primitive.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AGENT_CLOCK_SKEW_MS,
  AGENT_ID_HEADER,
  AGENT_NONCE_HEADER,
  AGENT_NONCE_PATTERN,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  signatureBase,
} from "@cpm/shared";
import { claimNonce } from "../cluster/nonces";
import { type AgentCredentials, findAgentByAgentId } from "../models/agents";

export type VerifyResult =
  | { ok: true; agent: AgentCredentials }
  | { ok: false; status: number; error: string };

/** One message and status for every failure, or this becomes a probe for which part is right. */
const DENY: VerifyResult = {
  ok: false,
  status: 401,
  error: "The request is not signed by a paired agent.",
};

/** Constant-time comparison that tolerates length differences without leaking them by timing. */
function secureEquals(a: string, b: string): boolean {
  // timingSafeEqual throws on a length mismatch, which would itself be an oracle. Hashing both to
  // a fixed width first makes every comparison the same shape.
  const left = createHmac("sha256", "compare").update(Buffer.from(a, "utf8")).digest();
  const right = createHmac("sha256", "compare").update(Buffer.from(b, "utf8")).digest();
  return timingSafeEqual(left, right);
}

async function sha256Hex(body: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  return hasher.digest("hex");
}

// ─── Replay ──────────────────────────────────────────────────────────────────

/**
 * Shared by every replica: a subscription replayed to another one would displace the real agent's
 * stream. Past `timestamp + skew` the timestamp check refuses a replay alone, bounding a record.
 */
function claimReplayKey(key: string, timestamp: number, now: number): Promise<boolean> {
  return claimNonce(`agent:${key}`, timestamp + AGENT_CLOCK_SKEW_MS + 1, now);
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * One verdict per request object. A GraphQL document naming two agent fields verifies the same
 * request twice, and the second pass must not read as a replay of the first.
 */
const verdicts = new WeakMap<Request, Promise<VerifyResult>>();

/**
 * `body` is the raw text the agent signed, read once at the route: re-reading a consumed body would
 * hash the empty string and fail every POST.
 */
export function verifyAgentRequest(
  request: Request,
  body: string,
  now = Date.now(),
): Promise<VerifyResult> {
  const cached = verdicts.get(request);
  if (cached) return cached;
  const verdict = verify(request, body, now);
  verdicts.set(request, verdict);
  return verdict;
}

async function verify(request: Request, body: string, now: number): Promise<VerifyResult> {
  const agentId = request.headers.get(AGENT_ID_HEADER);
  const timestampRaw = request.headers.get(AGENT_TIMESTAMP_HEADER);
  const signature = request.headers.get(AGENT_SIGNATURE_HEADER);
  const nonce = request.headers.get(AGENT_NONCE_HEADER);
  if (!agentId || !timestampRaw || !signature) return DENY;
  if (nonce !== null && !AGENT_NONCE_PATTERN.test(nonce)) return DENY;

  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) return DENY;
  // A captured request stops being replayable in a minute rather than a day.
  if (Math.abs(now - timestamp) > AGENT_CLOCK_SKEW_MS) return DENY;

  const agent = await findAgentByAgentId(agentId);
  if (!agent) return DENY;

  const path = new URL(request.url).pathname;
  const expected = createHmac("sha256", agent.secret)
    .update(
      signatureBase(request.method, path, timestamp, await sha256Hex(body), nonce ?? undefined),
    )
    .digest("hex");

  if (!secureEquals(expected, signature)) return DENY;

  // Agents before 3.0.0-rc.4 sign without a nonce. A replay is byte-identical, so its signature
  // rejects it as well as a nonce would. Remove this fallback in the first release after 3.0.0.
  const replayKey = `${agent.agentId}\n${nonce ?? `sig:${signature}`}`;
  if (!(await claimReplayKey(replayKey, timestamp, now))) return DENY;

  return { ok: true, agent };
}
