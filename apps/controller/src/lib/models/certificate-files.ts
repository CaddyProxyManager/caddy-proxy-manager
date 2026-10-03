/**
 * Imported certificates an agent reads from files on its host. The agent sends PEM; nothing it
 * sends is stored until it parses here and the key matches, and an agent may only update the
 * certificates it is the source of. The certificate stays `type = "imported"`, so expiry, alerts
 * and the Imported tab treat it like any upload.
 */
import {
  type CertificateFileEntry,
  type CertificateFileError,
  type CertificateFileResult,
  type CertificateFileSource,
  isValidCertificateFilePath,
} from "@cpm/shared";
import { eq, inArray } from "drizzle-orm";
import db, { nowIso } from "../db";
import { logAuditEvent } from "../audit";
import { applyCaddyConfigToAgent } from "../caddy";
import { certificates } from "../db/schema";
import { domainError } from "../domain-error";
import { CERTIFICATE_FILE_ERROR_MESSAGES } from "../certificate-file-errors";
import { encryptSecret } from "../secret";
import { chainFingerprint, checkCertificatePair } from "../certificate-pem";
import { AGENT_FILE_SOURCE } from "../certificate-placement";
import {
  AgentUnavailableError,
  certificateFileAgents,
  listAgentCertificateFiles,
  readAgentCertificateFiles,
} from "../agent/client";
import { pushDesiredState } from "../agent/desired-state";
import { connectedAgents } from "../agent/registry";
import { type Certificate, getCertificate } from "./certificates";

function fileError(error: CertificateFileError) {
  return domainError(CERTIFICATE_FILE_ERROR_MESSAGES[error], {}, { status: 400 });
}

function agentUnavailable() {
  return domainError("certificateFileAgentUnavailable", {}, { status: 409 });
}

async function readFromAgent(
  agentRowId: number,
  files: CertificateFileSource[],
): Promise<CertificateFileResult[]> {
  try {
    return await readAgentCertificateFiles(agentRowId, files);
  } catch (error) {
    if (error instanceof AgentUnavailableError) throw agentUnavailable();
    // A timeout or a malformed reply: the directory could not be read this time.
    throw fileError("unavailable");
  }
}

/** For the picker. Keys are named, never read. */
export async function listCertificateFilesOnAgent(
  agentRowId: number,
): Promise<CertificateFileEntry[]> {
  try {
    return await listAgentCertificateFiles(agentRowId);
  } catch (error) {
    if (error instanceof AgentUnavailableError) throw agentUnavailable();
    throw fileError("unavailable");
  }
}

export function certificateFileAgentOptions(): { id: number; name: string }[] {
  return certificateFileAgents().map((agent) => ({ id: agent.agentRowId, name: agent.name }));
}

export type AgentFileCertificateInput = {
  name: string;
  agentRowId: number;
  certPath: string;
  keyPath: string;
};

/** Read once before storing, so a wrong path or key is refused now rather than listed broken. */
export async function createCertificateFromAgentFiles(
  input: AgentFileCertificateInput,
  actorUserId: number,
): Promise<Certificate> {
  if (!isValidCertificateFilePath(input.certPath) || !isValidCertificateFilePath(input.keyPath)) {
    throw fileError("invalid-path");
  }
  if (!Number.isInteger(input.agentRowId) || input.agentRowId <= 0) throw agentUnavailable();
  const [result] = await readFromAgent(input.agentRowId, [
    { id: 0, certPath: input.certPath, keyPath: input.keyPath },
  ]);
  if (!result?.ok) throw fileError(result?.error ?? "unavailable");
  if (result.certificatePem === undefined || result.keyPem === undefined) {
    throw fileError("unavailable");
  }
  const pair = checkCertificatePair(result.certificatePem, result.keyPem);
  if (!pair.ok) throw fileError(pair.error);

  const name = input.name.trim() || pair.names[0] || input.certPath;
  const now = nowIso();
  const [record] = await db
    .insert(certificates)
    .values({
      name,
      type: "imported",
      domainNames: JSON.stringify(pair.names),
      autoRenew: false,
      providerOptions: null,
      certificatePem: pair.certificatePem,
      privateKeyPem: encryptSecret(pair.keyPem),
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
      source: AGENT_FILE_SOURCE,
      sourceAgentId: input.agentRowId,
      sourceCertPath: input.certPath,
      sourceKeyPath: input.keyPath,
      sourceReadAt: now,
      sourceError: null,
    })
    .returning();
  if (!record) throw domainError("failedToCreateCertificate");

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "certificate",
    entityId: record.id,
    summary: `Created certificate ${name}`,
    data: { source: AGENT_FILE_SOURCE, agentId: input.agentRowId, certPath: input.certPath },
  });
  // No host uses it yet, so no apply: only the agent's list of files to keep reading changes.
  await pushDesiredState();
  return (await getCertificate(record.id))!;
}

/** "Re-read now". A failure is stored on the row, as a poll's would be, and shown there. */
export async function rereadCertificateFile(id: number, actorUserId: number): Promise<Certificate> {
  const existing = await getCertificate(id);
  if (!existing || existing.source !== AGENT_FILE_SOURCE) {
    throw domainError("certificateNotFound", {}, { status: 404 });
  }
  if (existing.sourceAgentId === null || !existing.sourceCertPath || !existing.sourceKeyPath) {
    throw agentUnavailable();
  }
  const results = await readFromAgent(existing.sourceAgentId, [
    { id, certPath: existing.sourceCertPath, keyPath: existing.sourceKeyPath },
  ]);
  await ingestCertificateFileResults(existing.sourceAgentId, results, actorUserId);
  return (await getCertificate(id))!;
}

export type CertificateFileIngest = {
  /** Ids sent without PEM whose fingerprint is not the stored one. */
  resend: number[];
  /** Ids that are not this agent's file certificates. */
  refused: number[];
};

/**
 * Store what the agent read. An unchanged chain is a no-op beyond "last read", with no apply; a
 * failure keeps the last good certificate serving and records why. Only this agent reloads.
 */
export async function ingestCertificateFileResults(
  agentRowId: number,
  results: CertificateFileResult[],
  actorUserId: number | null = null,
): Promise<CertificateFileIngest> {
  const outcome: CertificateFileIngest = { resend: [], refused: [] };
  const ids = [...new Set(results.map((result) => result.id))];
  if (ids.length === 0) return outcome;
  const rows = await db
    .select({
      id: certificates.id,
      name: certificates.name,
      domainNames: certificates.domainNames,
      certificatePem: certificates.certificatePem,
      source: certificates.source,
      sourceAgentId: certificates.sourceAgentId,
      sourceError: certificates.sourceError,
    })
    .from(certificates)
    .where(inArray(certificates.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const now = nowIso();
  let changed = false;
  for (const result of results) {
    const row = byId.get(result.id);
    // Another agent's certificate, an upload, or one deleted since: never this agent's to write.
    if (!row || row.source !== AGENT_FILE_SOURCE || row.sourceAgentId !== agentRowId) {
      outcome.refused.push(result.id);
      continue;
    }
    const where = eq(certificates.id, row.id);
    if (!result.ok) {
      if (row.sourceError !== result.error) {
        await db.update(certificates).set({ sourceError: result.error }).where(where);
      }
      continue;
    }
    if (result.certificatePem === undefined || result.keyPem === undefined) {
      if (row.certificatePem && chainFingerprint(row.certificatePem) === result.fingerprint) {
        await db.update(certificates).set({ sourceReadAt: now, sourceError: null }).where(where);
      } else {
        outcome.resend.push(row.id);
      }
      continue;
    }
    const pair = checkCertificatePair(result.certificatePem, result.keyPem);
    if (!pair.ok) {
      await db.update(certificates).set({ sourceError: pair.error }).where(where);
      continue;
    }
    if (row.certificatePem === pair.certificatePem) {
      await db.update(certificates).set({ sourceReadAt: now, sourceError: null }).where(where);
      continue;
    }

    const previousNames = JSON.parse(row.domainNames) as string[];
    const namesChanged = JSON.stringify(previousNames) !== JSON.stringify(pair.names);
    await db
      .update(certificates)
      .set({
        certificatePem: pair.certificatePem,
        privateKeyPem: encryptSecret(pair.keyPem),
        domainNames: JSON.stringify(pair.names),
        sourceReadAt: now,
        sourceError: null,
        updatedAt: now,
      })
      .where(where);
    await logAuditEvent({
      userId: actorUserId,
      action: namesChanged ? "certificate_file_names_changed" : "certificate_file_renewed",
      entityType: "certificate",
      entityId: row.id,
      summary: namesChanged
        ? `Read a new version of certificate ${row.name} with different names`
        : `Read a new version of certificate ${row.name}`,
      data: {
        agentId: agentRowId,
        fingerprint: pair.fingerprint,
        ...(namesChanged ? { from: previousNames, to: pair.names } : {}),
      },
    });
    changed = true;
  }

  if (changed) {
    const agent = connectedAgents().find((candidate) => candidate.agentRowId === agentRowId);
    if (agent) {
      await applyCaddyConfigToAgent(agent).catch((error: unknown) => {
        console.error(`[agent] could not apply ${agent.name}'s renewed certificates:`, error);
      });
    }
  }
  return outcome;
}
