/** Its own module: desired state reads it, and the certificate model imports desired state. */
import type { CertificateFileSource } from "@cpm/shared";
import { and, eq } from "drizzle-orm";
import db from "../db";
import { certificates } from "../db/schema";
import { AGENT_FILE_SOURCE } from "../certificate-placement";

/** What the agent is asked to keep reading. Only its own rows: the list names paths on its host. */
export async function certificateFileSources(agentRowId: number): Promise<CertificateFileSource[]> {
  const rows = await db
    .select({
      id: certificates.id,
      certPath: certificates.sourceCertPath,
      keyPath: certificates.sourceKeyPath,
    })
    .from(certificates)
    .where(
      and(eq(certificates.source, AGENT_FILE_SOURCE), eq(certificates.sourceAgentId, agentRowId)),
    );
  return rows.flatMap((row) =>
    row.certPath && row.keyPath
      ? [{ id: row.id, certPath: row.certPath, keyPath: row.keyPath }]
      : [],
  );
}
