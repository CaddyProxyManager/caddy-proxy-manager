import { NextResponse } from "next/server";
import { requireAdmin } from "@/src/lib/auth";
import { listAgentCertificates } from "@/src/lib/agent/client";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { renewalsPending, settleRenewals } from "@/src/lib/certificates/renewals";

/** Also completes a pending "Renew now": a newer certificate returns the name to its policy. */
export async function GET() {
  await requireAdmin();
  const agents = await listAgentCertificates();
  let settled = false;
  for (const agent of agents) {
    if (agent.certificates && settleRenewals(agent.agentId, agent.certificates)) settled = true;
  }
  if (settled) {
    await applyCaddyConfig().catch((error) =>
      console.error("[certificates] Reverting a finished renewal failed:", error),
    );
  }
  return NextResponse.json(
    { agents, renewing: [...renewalsPending().keys()] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
