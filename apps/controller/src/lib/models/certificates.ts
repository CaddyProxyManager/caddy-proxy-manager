import db, { nowIso, toIso } from "../db";
import { logAuditEvent } from "../audit";
import { applyCaddyConfig } from "../caddy";
import { certificates } from "../db/schema";
import { desc, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secret";
import { domainError } from "../domain-error";
import {
  normalizeCertificateProviderOptions,
  parseStoredCertificateProviderOptions,
  sanitizeStoredCertificateProviderOptions,
} from "../certificate-provider-options";

export type CertificateType = "managed" | "imported";

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
  };
}

export async function listCertificates(): Promise<Certificate[]> {
  const rows = await db.select().from(certificates).orderBy(desc(certificates.createdAt));
  return rows.map(parseCertificate);
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

export async function updateCertificate(
  id: number,
  input: Partial<CertificateInput>,
  actorUserId: number,
) {
  const existing = await getCertificate(id);
  if (!existing) {
    throw domainError("certificateNotFound");
  }

  const merged: CertificateInput = {
    name: input.name ?? existing.name,
    type: input.type ?? existing.type,
    domainNames: input.domainNames ?? existing.domainNames,
    autoRenew: input.autoRenew ?? existing.autoRenew,
    providerOptions: input.providerOptions ?? existing.providerOptions,
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
  });
  await applyCaddyConfig();
  return (await getCertificate(id))!;
}

export async function deleteCertificate(id: number, actorUserId: number) {
  const existing = await getCertificate(id);
  if (!existing) {
    throw domainError("certificateNotFound");
  }

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
