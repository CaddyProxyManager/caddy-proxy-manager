/**
 * POST /api/agent/v1/pair - a one-time credential for a shared secret; unauthenticated, as no
 * secret exists yet. A known agentId re-pairs only with a credential minted for it. 400/401, not
 * 404: an operator must tell "wrong code" from "wrong address", and guessing is throttled.
 */

import { randomBytes } from "node:crypto";
import type { AgentPairRequest, AgentPairResponse } from "@cpm/shared";
import {
  clientThrottled,
  recordFailedGuess,
  redeemPairingCode,
  redeemRepairCode,
} from "@/src/lib/agent/pairing-codes";
import {
  ensureBootstrapToken,
  looksLikeBootstrapToken,
  recordBundledAgent,
  redeemBootstrapToken,
} from "@/src/lib/agent/bootstrap";
import {
  findAgentRowByAgentId,
  getControllerId,
  insertPairedAgent,
  replaceAgentSecret,
} from "@/src/lib/models/agents";
import { getClientIp } from "@/src/lib/http/client-ip";
import { isDemoMode } from "@/src/lib/demo/mode";
import { controllerDisplayName } from "@/src/lib/agent/controller-name";

/** Four short fields; anything larger is not a pairing. */
const MAX_BODY_BYTES = 4 * 1024;

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  // A paired agent runs a real Caddy. 403 rather than 401, which an agent reads as a bad code.
  if (isDemoMode()) return bad("This controller is in demo mode and does not pair agents.", 403);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return bad("That request is too large to be a pairing.", 413);

  let parsed: AgentPairRequest;
  try {
    parsed = JSON.parse(raw) as AgentPairRequest;
  } catch {
    return bad("The request is not valid JSON.");
  }

  const agentId = typeof parsed?.agentId === "string" ? parsed.agentId.trim() : "";
  const code = typeof parsed?.code === "string" ? parsed.code : "";
  if (!/^[0-9a-f]{8,64}$/.test(agentId)) return bad("The agent id is not valid.");
  if (code.length === 0) return bad("A pairing code is required.");

  const existing = await findAgentRowByAgentId(agentId);
  // Before any credential is spent: pairing must never be how a disabled agent comes back.
  if (existing && !existing.enabled) return bad("This agent is disabled on the controller.", 403);

  // A bootstrap token proves access to the data volume. Unthrottled: 64 hex characters are not
  // guessable, and the bundled agent retries a stale one every few seconds.
  const bootstrap = looksLikeBootstrapToken(code);
  if (bootstrap) {
    if (!(await redeemBootstrapToken(code, agentId, existing !== null))) {
      // Otherwise only startup writes one, and a late agent would wait forever. Written only while
      // the bundled agent still wants pairing.
      await ensureBootstrapToken();
      return bad("That bootstrap token is not valid.", 401);
    }
  } else {
    // Each code has its own budget too, for when no trusted address is known.
    const client = (await getClientIp(request.headers)) ?? "unknown";
    if (await clientThrottled(client)) {
      return bad("Too many wrong pairing codes from this address. Try again in a minute.", 429);
    }
    const redeemed = existing
      ? await redeemRepairCode(agentId, code)
      : await redeemPairingCode(code);
    if (!redeemed.ok) {
      await recordFailedGuess(client);
      return bad(redeemed.error, 401);
    }
  }

  const secret = randomBytes(32).toString("hex");
  if (existing) {
    await replaceAgentSecret({ agentId, secret });
  } else {
    // Display only; routing is by agentId. Bounded because it is rendered.
    const name =
      typeof parsed.agentName === "string" && parsed.agentName.trim().length > 0
        ? parsed.agentName.trim().slice(0, 128)
        : `Agent ${agentId.slice(0, 8)}`;
    if (!(await insertPairedAgent({ name, agentId, secret }))) {
      return bad("Another pairing for this agent landed first.", 409);
    }
  }
  if (bootstrap) await recordBundledAgent(agentId);

  const [controllerName, controllerId] = await Promise.all([
    controllerDisplayName(),
    getControllerId(),
  ]);

  return Response.json({
    secret,
    controllerId,
    controllerName,
  } satisfies AgentPairResponse);
}
