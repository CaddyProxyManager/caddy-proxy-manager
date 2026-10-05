import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import AgentsClient, { type AgentRow } from "./AgentsClient";
import { storedErrorMessage } from "@/src/lib/errors/action-error";
import { getAllAgentStatuses, listAgentOptions } from "@/src/lib/agent/client";
import { logAccessFixes } from "@/src/lib/agent/log-access";
import { connectedAgents } from "@/src/lib/agent/registry";
import { listAgents } from "@/src/lib/models/agents";
import { listHostAssignments } from "@/src/lib/models/host-agents";
import { canManage, requireAccess, visibleIdFilter } from "@/src/lib/users/permissions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("agents") };
}

/** How many of each kind of host are pinned to this agent, not counting the unassigned ones. */
function countAssigned(assignments: Map<number, number[]>, agentRowId: number): number {
  let total = 0;
  for (const agentIds of assignments.values()) {
    if (agentIds.includes(agentRowId)) total += 1;
  }
  return total;
}

export default async function AgentsPage() {
  const access = await requireAccess();
  // For a status failure this side worded, such as an agent that has not reported yet.
  const tRoot = await getTranslations();

  const [paired, statuses, httpAssignments, l4Assignments, agentOptions] = await Promise.all([
    listAgents(),
    getAllAgentStatuses(),
    listHostAssignments("http"),
    listHostAssignments("l4"),
    listAgentOptions().catch(() => []),
  ]);

  // Names, because that is all getAllAgentStatuses reports against. Routing is by row id
  // everywhere else, so this map exists only to attach a status to the row it came from.
  const live = new Map(connectedAgents().map((agent) => [agent.agentRowId, agent]));
  const byName = new Map(statuses.map((result) => [result.agent, result]));

  const visible = visibleIdFilter(access, "agent");
  const rows: AgentRow[] = paired
    .filter((agent) => visible === null || visible.has(agent.id))
    .map((agent) => {
      const status = live.get(agent.id)?.status ?? null;
      const reported = byName.get(agent.name);
      return {
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        connected: live.has(agent.id),
        lastSeenAt: agent.lastSeenAt,
        version: status?.version ?? null,
        buildState: status?.caddyBuild.status.state ?? "idle",
        buildMessage:
          reported?.ok === false
            ? storedErrorMessage(
                tRoot,
                reported.error,
                reported.code ? { code: reported.code, params: {} } : null,
              )
            : (status?.caddyBuild.status.message ?? null),
        hasOwnBuildSettings: agent.hasOwnBuildSettings,
        assignedHttpHosts: countAssigned(httpAssignments, agent.id),
        assignedL4Hosts: countAssigned(l4Assignments, agent.id),
        canManage: canManage(access, "agent", agent.id),
        logAccessFixes: logAccessFixes(status?.logAccess),
      };
    });

  // Only used to decide the empty state's wording: "none are paired" and "none are yours" are
  // different problems with different fixes, and an operator cannot tell them apart otherwise.
  const anyPaired = agentOptions.length > 0;

  return <AgentsClient agents={rows} anyPaired={anyPaired} isAdmin={access.isAdmin} />;
}
