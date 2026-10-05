/**
 * POST /api/agent/v1/pair/preview: lets `cpm-agent --pair` confirm the controller by name before
 * spending the code, so a typo'd address cannot pair elsewhere. Same rules as the pair route: a
 * wrong code costs the throttle and the code's budget. Bootstrap tokens have no one to ask.
 */

import type { AgentPairPreviewRequest, AgentPairPreviewResponse } from "@cpm/shared";
import {
  checkPairingCode,
  checkRepairCode,
  clientThrottled,
  recordFailedGuess,
} from "@/src/lib/agent/pairing-codes";
import { looksLikeBootstrapToken } from "@/src/lib/agent/bootstrap";
import { findAgentRowByAgentId, getControllerId } from "@/src/lib/models/agents";
import { getClientIp } from "@/src/lib/http/client-ip";
import { isDemoMode } from "@/src/lib/demo/mode";
import { controllerDisplayName } from "@/src/lib/agent/controller-name";

/** Two short fields; anything larger is not a preview. */
const MAX_BODY_BYTES = 4 * 1024;

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  if (isDemoMode()) return bad("This controller is in demo mode and does not pair agents.", 403);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return bad("That request is too large to be a pairing.", 413);

  let parsed: AgentPairPreviewRequest;
  try {
    parsed = JSON.parse(raw) as AgentPairPreviewRequest;
  } catch {
    return bad("The request is not valid JSON.");
  }

  const agentId = typeof parsed?.agentId === "string" ? parsed.agentId.trim() : "";
  const code = typeof parsed?.code === "string" ? parsed.code : "";
  if (!/^[0-9a-f]{8,64}$/.test(agentId)) return bad("The agent id is not valid.");
  if (code.length === 0) return bad("A pairing code is required.");
  if (looksLikeBootstrapToken(code)) return bad("Bootstrap tokens are not previewed.");

  const existing = await findAgentRowByAgentId(agentId);

  const client = (await getClientIp(request.headers)) ?? "unknown";
  if (clientThrottled(client)) {
    return bad("Too many wrong pairing codes from this address. Try again in a minute.", 429);
  }
  const checked = existing ? checkRepairCode(agentId, code) : checkPairingCode(code);
  if (!checked.ok) {
    recordFailedGuess(client);
    return bad(checked.error, 401);
  }
  // After the code check, or a wrong-code caller could probe which agent ids are disabled.
  if (existing && !existing.enabled) return bad("This agent is disabled on the controller.", 403);

  const [controllerName, controllerId] = await Promise.all([
    controllerDisplayName(),
    getControllerId(),
  ]);

  return Response.json({
    controllerId,
    controllerName,
    repair: existing !== null,
  } satisfies AgentPairPreviewResponse);
}
