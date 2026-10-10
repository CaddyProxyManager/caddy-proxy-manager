import { createHash } from "node:crypto";
import db, { nowIso, runInTransaction, toIso } from "../db";
import { auditEventRow, chainedAuditInsert, logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";
import { applyCaddyConfig } from "../caddy";
import { certificates, proxyHosts } from "../db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import { getDashboardSettings } from "../settings";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets";
import { domainError } from "../errors/domain-error";
import { checkCertificatePair } from "../certificates/pem";
import {
  normalizeCertificateProviderOptions,
  parseStoredCertificateProviderOptions,
  sanitizeStoredCertificateProviderOptions,
} from "../certificates/provider-options";

export type CertificateType = "managed" | "imported";

/** `agent-file`: read from files on one agent's host; see models/certificate-files.ts. */
export type CertificateSource = "upload" | "agent-file";

export type Certificate = {
  id: number;
  name: string;
  type: CertificateType;
  domainNames: string[];
  autoRenew: boolean;
  providerOptions: Record<string, unknown> | null;
  certificatePem: string | null;
  privateKeyPem: string | null;
  createdAt: string;
  updatedAt: string;
  source: CertificateSource;
  sourceAgentId: number | null;
  sourceCertPath: string | null;
  sourceKeyPath: string | null;
  sourceReadAt: string | null;
  /** A `CertificateFileError` code. */
  sourceError: string | null;
};

export type CertificateInput = {
  name: string;
  type: CertificateType;
  domainNames: string[];
  autoRenew?: boolean;
  providerOptions?: Record<string, unknown> | null;
  certificatePem?: string | null;
  privateKeyPem?: string | null;
};

type CertificateRow = typeof certificates.$inferSelect;

function parseCertificate(row: CertificateRow): Certificate {
  return {
    id: row.id,
    name: row.name,
    type: row.type as CertificateType,
    domainNames: JSON.parse(row.domainNames),
    autoRenew: row.autoRenew,
    providerOptions: parseStoredCertificateProviderOptions(row.providerOptions),
    certificatePem: row.certificatePem,
    privateKeyPem: row.privateKeyPem ? decryptSecret(row.privateKeyPem) : null,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
    source: row.source === "agent-file" ? "agent-file" : "upload",
    sourceAgentId: row.sourceAgentId,
    sourceCertPath: row.sourceCertPath,
    sourceKeyPath: row.sourceKeyPath,
    sourceReadAt: toIso(row.sourceReadAt),
    sourceError: row.sourceError,
  };
}

export async function listCertificates(): Promise<Certificate[]> {
  const rows = await db.select().from(certificates).orderBy(desc(certificates.createdAt));
  return rows.map(parseCertificate);
}

/** What a list needs: no private key, so nothing is decrypted to name a certificate. */
export type CertificateSummary = Pick<
  Certificate,
  "id" | "name" | "type" | "domainNames" | "certificatePem" | "sourceError" | "sourceReadAt"
>;

export async function listCertificateSummaries(): Promise<CertificateSummary[]> {
  const rows = await db
    .select({
      id: certificates.id,
      name: certificates.name,
      type: certificates.type,
      domainNames: certificates.domainNames,
      certificatePem: certificates.certificatePem,
      sourceError: certificates.sourceError,
      sourceReadAt: certificates.sourceReadAt,
    })
    .from(certificates)
    .orderBy(desc(certificates.createdAt));
  return rows.map((row) => ({
    ...row,
    type: row.type as CertificateType,
    domainNames: JSON.parse(row.domainNames),
    sourceReadAt: toIso(row.sourceReadAt),
  }));
}

export async function getCertificate(id: number): Promise<Certificate | null> {
  const cert = await db.query.certificates.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  return cert ? parseCertificate(cert) : null;
}

function validateCertificateInput(input: CertificateInput) {
  if (!input.domainNames || input.domainNames.length === 0) {
    throw domainError("certificateDomainsRequired");
  }
  if (input.type === "imported") {
    if (!input.certificatePem || !input.privateKeyPem) {
      throw domainError("importedCertificatePemRequired");
    }
    // Caddy refuses a pair it cannot load, and with it the whole config: every host stops updating.
    const pair = checkCertificatePair(input.certificatePem, input.privateKeyPem);
    if (!pair.ok && pair.error !== "no-names") {
      throw domainError(
        pair.error === "not-a-certificate"
          ? "importedCertificateInvalid"
          : pair.error === "not-a-key"
            ? "importedCertificateKeyInvalid"
            : "importedCertificateKeyMismatch",
        {},
        { status: 400 },
      );
    }
  }
}

export async function createCertificate(input: CertificateInput, actorUserId: number) {
  validateCertificateInput(input);
  const now = nowIso();
  const providerOptions = normalizeCertificateProviderOptions(input.providerOptions);
  const [record] = await db
    .insert(certificates)
    .values({
      name: input.name.trim(),
      type: input.type,
      domainNames: JSON.stringify(
        Array.from(new Set(input.domainNames.map((domain) => domain.trim().toLowerCase()))),
      ),
      autoRenew: input.autoRenew ?? true,
      providerOptions: providerOptions ? JSON.stringify(providerOptions) : null,
      certificatePem: input.certificatePem ?? null,
      privateKeyPem: input.privateKeyPem ? encryptSecret(input.privateKeyPem) : null,
      createdAt: now,
      updatedAt: now,
      createdBy: actorUserId,
    })
    .returning();

  if (!record) {
    throw domainError("failedToCreateCertificate");
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "certificate",
    entityId: record.id,
    summary: `Created certificate ${input.name}`,
  });
  await applyCaddyConfig();
  return (await getCertificate(record.id))!;
}

/** PEM bodies are long and the key secret: the diff compares a short digest of each instead. */
function auditedCertificate(cert: Certificate | null) {
  if (!cert) return null;
  const digest = (pem: string | null) =>
    pem ? `sha256:${createHash("sha256").update(pem).digest("hex").slice(0, 16)}` : null;
  const { certificatePem, privateKeyPem, ...rest } = cert;
  return { ...rest, certificate: digest(certificatePem), keyDigest: digest(privateKeyPem) };
}

export async function updateCertificate(
  id: number,
  input: Partial<CertificateInput>,
  actorUserId: number,
) {
  const existing = await getCertificate(id);
  if (!existing) {
    throw domainError("certificateNotFound");
  }
  // The files are the source of truth; an edit here would be overwritten on the next read.
  const changes = <T>(next: T | null | undefined, current: T) =>
    next != null && JSON.stringify(next) !== JSON.stringify(current);
  if (
    existing.source === "agent-file" &&
    (changes(input.certificatePem, existing.certificatePem) ||
      changes(input.privateKeyPem, existing.privateKeyPem) ||
      changes(input.domainNames, existing.domainNames) ||
      changes(input.type, existing.type))
  ) {
    throw domainError("certificateFileFieldsReadOnly", { name: existing.name }, { status: 400 });
  }

  const merged: CertificateInput = {
    name: input.name ?? existing.name,
    type: input.type ?? existing.type,
    domainNames: input.domainNames ?? existing.domainNames,
    autoRenew: input.autoRenew ?? existing.autoRenew,
    // Null clears the override, so the editor can take one away again.
    providerOptions:
      input.providerOptions === undefined ? existing.providerOptions : input.providerOptions,
    certificatePem: input.certificatePem ?? existing.certificatePem,
    privateKeyPem: input.privateKeyPem ?? existing.privateKeyPem,
  };

  validateCertificateInput(merged);

  const now = nowIso();
  const providerOptions = normalizeCertificateProviderOptions(merged.providerOptions);
  await db
    .update(certificates)
    .set({
      name: merged.name.trim(),
      type: merged.type,
      domainNames: JSON.stringify(Array.from(new Set(merged.domainNames))),
      autoRenew: merged.autoRenew,
      providerOptions: providerOptions ? JSON.stringify(providerOptions) : null,
      certificatePem: merged.certificatePem ?? null,
      privateKeyPem: merged.privateKeyPem ? encryptSecret(merged.privateKeyPem) : null,
      updatedAt: now,
    })
    .where(eq(certificates.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "certificate",
    entityId: id,
    summary: `Updated certificate ${merged.name}`,
    changes: diffAuditRecords(
      auditedCertificate(existing),
      auditedCertificate(await getCertificate(id)),
    ),
  });
  await applyCaddyConfig();
  return (await getCertificate(id))!;
}

/**
 * The foreign key is `set null`, which would quietly move every host using it to ACME - a public
 * issuance nobody asked for, and a broken host behind a firewall - so a delete is refused instead.
 */
async function assertCertificatesUnused(ids: number[]): Promise<void> {
  const [dashboard, hosts] = await Promise.all([
    getDashboardSettings(),
    db
      .select({ name: proxyHosts.name })
      .from(proxyHosts)
      .where(inArray(proxyHosts.certificateId, ids)),
  ]);
  if (hosts.length > 0) {
    throw domainError(
      "certificateInUseByHosts",
      { hosts: hosts.map((host) => host.name) },
      { status: 409 },
    );
  }
  // Counted while the dashboard host is off too: turning it back on would fall back the same way.
  const dashboardCertificateId = dashboard?.options?.certificateId;
  if (dashboardCertificateId != null && ids.includes(dashboardCertificateId)) {
    throw domainError("certificateInUseByDashboard", {}, { status: 409 });
  }
}

export async function deleteCertificate(id: number, actorUserId: number) {
  const existing = await getCertificate(id);
  if (!existing) {
    throw domainError("certificateNotFound");
  }
  await assertCertificatesUnused([id]);

  await db.delete(certificates).where(eq(certificates.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "certificate",
    entityId: id,
    summary: `Deleted certificate ${existing.name}`,
  });
  await applyCaddyConfig();
}

/**
 * The imported tab's "Delete unused": the ids the dialog listed, with usage recomputed here so a
 * host that took one in the meantime refuses the whole batch rather than losing it.
 */
export async function deleteUnusedCertificates(
  ids: number[],
  actorUserId: number,
): Promise<{ count: number }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { count: 0 };
  const rows = await db
    .select({ id: certificates.id, name: certificates.name, type: certificates.type })
    .from(certificates)
    .where(inArray(certificates.id, unique));
  if (rows.length !== unique.length || rows.some((row) => row.type !== "imported")) {
    throw domainError("certificateNotFound", {}, { status: 404 });
  }
  await assertCertificatesUnused(unique);

  await runInTransaction((tx) => [
    tx.delete(certificates).where(inArray(certificates.id, unique)),
    chainedAuditInsert(
      tx,
      rows.map((row) =>
        auditEventRow({
          userId: actorUserId,
          action: "delete",
          entityType: "certificate",
          entityId: row.id,
          summary: `Deleted certificate ${row.name}`,
          data: { bulk: true },
        }),
      ),
    ),
  ]);
  await applyCaddyConfig();
  return { count: rows.length };
}

/** Idempotent, with no one-time flag, so a restored legacy backup is repaired on next startup. */
export async function migrateLegacyCertificateStorage(): Promise<number> {
  const rows = await db
    .select({
      id: certificates.id,
      privateKeyPem: certificates.privateKeyPem,
      providerOptions: certificates.providerOptions,
    })
    .from(certificates);
  let migrated = 0;

  for (const row of rows) {
    const updates: Partial<Pick<CertificateRow, "privateKeyPem" | "providerOptions">> = {};
    if (row.privateKeyPem && !isEncryptedSecret(row.privateKeyPem)) {
      updates.privateKeyPem = encryptSecret(row.privateKeyPem);
    }

    const providerOptions = sanitizeStoredCertificateProviderOptions(row.providerOptions);
    if (providerOptions !== row.providerOptions) {
      updates.providerOptions = providerOptions;
    }

    if (Object.keys(updates).length === 0) continue;
    await db.update(certificates).set(updates).where(eq(certificates.id, row.id));
    migrated += 1;
  }

  return migrated;
}
