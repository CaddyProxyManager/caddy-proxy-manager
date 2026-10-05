/**
 * A certificate read from files on an agent is emitted into that agent's config alone, so a host
 * using it must be pinned to that agent alone: on any other agent the host would have no
 * certificate, and unpinned it would be served everywhere. Refused at every save that could break
 * it - the certificate, or the pins, changing.
 */
import { inArray } from "drizzle-orm";
import db from "../db";
import { certificates } from "../db/schema";
import { domainError } from "../errors/domain-error";

export const AGENT_FILE_SOURCE = "agent-file";

/** `agentIds` empty means every agent, which a file certificate never suits. */
export async function assertCertificatesServable(
  placements: { certificateId: number | null; agentIds: readonly number[] }[],
): Promise<void> {
  const ids = [
    ...new Set(placements.flatMap((p) => (p.certificateId == null ? [] : [p.certificateId]))),
  ];
  if (ids.length === 0) return;
  const rows = await db
    .select({
      id: certificates.id,
      name: certificates.name,
      source: certificates.source,
      sourceAgentId: certificates.sourceAgentId,
    })
    .from(certificates)
    .where(inArray(certificates.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const placement of placements) {
    const row = placement.certificateId == null ? null : byId.get(placement.certificateId);
    if (!row || row.source !== AGENT_FILE_SOURCE) continue;
    const pinnedThere =
      row.sourceAgentId !== null &&
      placement.agentIds.length > 0 &&
      placement.agentIds.every((agentId) => agentId === row.sourceAgentId);
    if (!pinnedThere) {
      throw domainError("certificateFileAgentOnly", { name: row.name }, { status: 400 });
    }
  }
}

export async function assertCertificateServable(
  certificateId: number | null,
  agentIds: readonly number[],
): Promise<void> {
  await assertCertificatesServable([{ certificateId, agentIds }]);
}
