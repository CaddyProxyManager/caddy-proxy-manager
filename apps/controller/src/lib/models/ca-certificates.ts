import db, { nowIso, toIso } from "../db";
import { logAuditEvent } from "../audit";
import { applyCaddyConfig } from "../caddy";
import {
  caCertificates,
  issuedClientCertificates,
  mtlsCertificateRoles,
  proxyHosts,
} from "../db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import { domainError } from "../domain-error";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secret";

function tryParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export type CaCertificate = {
  id: number;
  name: string;
  certificatePem: string;
  hasPrivateKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CaCertificateInput = {
  name: string;
  certificatePem: string;
  privateKeyPem?: string;
};

type CaCertificateRow = typeof caCertificates.$inferSelect;

function parseCaCertificate(row: CaCertificateRow): CaCertificate {
  return {
    id: row.id,
    name: row.name,
    certificatePem: row.certificatePem,
    hasPrivateKey: !!row.privateKeyPem,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

function sealKey(pem: string | undefined): string | null {
  const trimmed = pem?.trim();
  return trimmed ? encryptSecret(trimmed) : null;
}

/**
 * Encrypts private keys older releases stored in plain text. Idempotent and unflagged, like
 * `migrateLegacyCertificateStorage`, so a restored old backup is repaired on the next start.
 */
export async function migrateLegacyCaCertificateStorage(): Promise<number> {
  const rows = await db
    .select({ id: caCertificates.id, privateKeyPem: caCertificates.privateKeyPem })
    .from(caCertificates);
  let migrated = 0;
  for (const row of rows) {
    if (!row.privateKeyPem || isEncryptedSecret(row.privateKeyPem)) continue;
    await db
      .update(caCertificates)
      .set({ privateKeyPem: encryptSecret(row.privateKeyPem) })
      .where(eq(caCertificates.id, row.id));
    migrated += 1;
  }
  return migrated;
}

export async function listCaCertificates(): Promise<CaCertificate[]> {
  const rows = await db.select().from(caCertificates).orderBy(desc(caCertificates.createdAt));
  return rows.map(parseCaCertificate);
}

export async function getCaCertificatePrivateKey(id: number): Promise<string | null> {
  const cert = await db.query.caCertificates.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  if (!cert?.privateKeyPem) return null;
  try {
    // Plain text until the startup pass has sealed it; decryptSecret passes that through.
    return decryptSecret(cert.privateKeyPem, `CA certificate ${id} private key`);
  } catch (error) {
    // The raw error names key derivations; the admin needs to know what to do instead.
    console.error(`Failed to decrypt the private key of CA certificate ${id}:`, error);
    throw domainError("caCertificatePrivateKeyUnavailable", {}, { status: 409 });
  }
}

export async function getCaCertificate(id: number): Promise<CaCertificate | null> {
  const cert = await db.query.caCertificates.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  return cert ? parseCaCertificate(cert) : null;
}

export async function createCaCertificate(
  input: CaCertificateInput,
  actorUserId: number,
): Promise<CaCertificate> {
  const now = nowIso();
  const [record] = await db
    .insert(caCertificates)
    .values({
      name: input.name.trim(),
      certificatePem: input.certificatePem.trim(),
      privateKeyPem: sealKey(input.privateKeyPem),
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!record) {
    throw domainError("failedToCreateCaCertificate");
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "ca_certificate",
    entityId: record.id,
    summary: `Created CA certificate ${input.name}`,
  });
  await applyCaddyConfig();
  return (await getCaCertificate(record.id))!;
}

export async function updateCaCertificate(
  id: number,
  input: Partial<CaCertificateInput>,
  actorUserId: number,
): Promise<CaCertificate> {
  const existing = await getCaCertificate(id);
  if (!existing) {
    throw domainError("caCertificateNotFound");
  }

  const now = nowIso();
  await db
    .update(caCertificates)
    .set({
      name: input.name?.trim() ?? existing.name,
      certificatePem: input.certificatePem?.trim() ?? existing.certificatePem,
      ...(input.privateKeyPem !== undefined ? { privateKeyPem: sealKey(input.privateKeyPem) } : {}),
      updatedAt: now,
    })
    .where(eq(caCertificates.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "ca_certificate",
    entityId: id,
    summary: `Updated CA certificate ${input.name ?? existing.name}`,
  });
  await applyCaddyConfig();
  return (await getCaCertificate(id))!;
}

export async function deleteCaCertificate(id: number, actorUserId: number): Promise<void> {
  const existing = await getCaCertificate(id);
  if (!existing) {
    throw domainError("caCertificateNotFound");
  }

  // For the reference check below and the cascade after it.
  const issuedCerts = await db
    .select({ id: issuedClientCertificates.id })
    .from(issuedClientCertificates)
    .where(eq(issuedClientCertificates.caCertificateId, id));
  const issuedCertIds = issuedCerts.map((c) => c.id);
  const issuedCertIdSet = new Set(issuedCertIds);

  const affectedRoleIds = new Set<number>();
  if (issuedCertIds.length > 0) {
    const roleRows = await db
      .select({ roleId: mtlsCertificateRoles.mtlsRoleId })
      .from(mtlsCertificateRoles)
      .where(inArray(mtlsCertificateRoles.issuedClientCertificateId, issuedCertIds));
    for (const row of roleRows) affectedRoleIds.add(row.roleId);
  }

  // Through an issued cert, a role holding one, or the deprecated whole-CA list.
  const allHosts = await db
    .select({ meta: proxyHosts.meta, name: proxyHosts.name })
    .from(proxyHosts);
  const referencing = allHosts.filter((host) => {
    const meta = tryParseJson<{
      mtls?: {
        enabled?: boolean;
        trusted_client_cert_ids?: number[];
        trusted_role_ids?: number[];
        ca_certificate_ids?: number[];
      };
    }>(host.meta, {});
    if (!meta.mtls?.enabled) return false;
    const trustsCert =
      meta.mtls.trusted_client_cert_ids?.some((cid) => issuedCertIdSet.has(cid)) ?? false;
    const trustsRole = meta.mtls.trusted_role_ids?.some((rid) => affectedRoleIds.has(rid)) ?? false;
    const trustsCa = meta.mtls.ca_certificate_ids?.includes(id) ?? false;
    return trustsCert || trustsRole || trustsCa;
  });

  if (referencing.length > 0) {
    // A 409 over REST; the names go as a list for the dialog to format.
    throw domainError(
      "caCertificateInUse",
      { names: referencing.map((h) => h.name) },
      { status: 409 },
    );
  }

  // By hand: bun:sqlite leaves PRAGMA foreign_keys OFF, so the schema's cascade never fires.
  if (issuedCertIds.length > 0) {
    await db
      .delete(mtlsCertificateRoles)
      .where(inArray(mtlsCertificateRoles.issuedClientCertificateId, issuedCertIds));
    await db
      .delete(issuedClientCertificates)
      .where(eq(issuedClientCertificates.caCertificateId, id));
  }

  await db.delete(caCertificates).where(eq(caCertificates.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "ca_certificate",
    entityId: id,
    summary: `Deleted CA certificate ${existing.name}`,
  });
  await applyCaddyConfig();
}
