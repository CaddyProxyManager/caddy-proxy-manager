import { type NextRequest, NextResponse } from "next/server";
import { getFormatter, getTranslations } from "next-intl/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { extractErrorMessage } from "@/src/lib/errors/action-error";
import { caddyBuildAgents } from "@/src/lib/agent/client";
import {
  applyCaddyBuild,
  getCaddyBuildDiff,
  getCaddyBuildStatus,
  parseAgentRowId,
} from "@/src/lib/caddy/image-build";
import { DomainError } from "@/src/lib/errors/domain-error";

/**
 * GET /api/caddy-build - the module diff plus the agent's rebuild status. Polled by the settings
 * panel: compiling Caddy takes minutes, too long for a server action to hold open. `external`
 * lists the agents that load an operator-built image instead, and `builders` the rest.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    // `?agent=<row id>` narrows both to one agent, which is what the settings panel polls with
    // once an agent is being edited separately. Absent is the fleet-wide answer.
    const agentRowId = parseAgentRowId(request.nextUrl.searchParams.get("agent"));
    const [diff, status] = await Promise.all([
      getCaddyBuildDiff(agentRowId),
      getCaddyBuildStatus(agentRowId),
    ]);
    const { external, builders } = caddyBuildAgents(agentRowId);
    return NextResponse.json({
      diff,
      status,
      builders,
      external: external.map(({ name, external: image }) => ({ name, ...image })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** POST /api/caddy-build - write the build override and trigger the agent. */
export async function POST(request: NextRequest) {
  try {
    await requireApiUser(request);
    const status = await applyCaddyBuild(
      parseAgentRowId(request.nextUrl.searchParams.get("agent")),
    );
    return NextResponse.json({ status });
  } catch (error) {
    // Not `/api/v1`: the settings panel shows this error as it arrives, so a refusal with a code -
    // a custom module path the build would choke on - is said in the reader's language.
    if (error instanceof DomainError) {
      const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
      return NextResponse.json(
        { error: extractErrorMessage(t, error, error.message, format) },
        { status: error.status ?? 400 },
      );
    }
    return apiErrorResponse(error);
  }
}
