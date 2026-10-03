import db, { nowIso, toIso } from "../db";
import { logAuditEvent } from "../audit";
import { applyCaddyConfig } from "../caddy";
import { issuedClientCertificates } from "../db/schema";
import { desc, eq } from "drizzle-orm";
import { domainError } from "../domain-error";

export type IssuedClientCertificate = {
  id: number;
  caCertificateId: number;
  commonName: string;
  serialNumber: string;
  fingerprintSha256: string;
  certificatePem: string;
  validFrom: string;
  validTo: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IssuedClientCertificateInput = {
  caCertificateId: number;
  commonName: string;
  serialNumber: string;
  fingerprintSha256: string;
  certificatePem: string;
  validFrom: string;
  validTo: string;
};

type IssuedClientCertificateRow = typeof issuedClientCertificates.$inferSelect;

/**
 * As openssl and X509Certificate print it: upper-case hex in whole bytes, no leading zero byte.
 * Applied on read, since rows issued earlier hold forge's form ("1A0F…" for "01A0F…"); nothing
 * matches on the serial (revocation goes by id, Caddy by the PEM), so no migration is needed.
 */
export function canonicalSerialNumber(serial: string): string {
  const trimmed = serial.trim();
  const hex = trimmed.replace(/:/g, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) return trimmed;
  const whole = hex.length % 2 === 1 ? `0${hex}` : hex;
  return whole.replace(/^(?:00)+(?=..)/, "").toUpperCase();
}

function parseIssuedClientCertificate(row: IssuedClientCertificateRow): IssuedClientCertificate {
  return {
    id: row.id,
    caCertificateId: row.caCertificateId,
    commonName: row.commonName,
    serialNumber: canonicalSerialNumber(row.serialNumber),
    fingerprintSha256: row.fingerprintSha256,
    certificatePem: row.certificatePem,
    validFrom: toIso(row.validFrom)!,
    validTo: toIso(row.validTo)!,
    revokedAt: toIso(row.revokedAt),
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

export async function listIssuedClientCertificates(): Promise<IssuedClientCertificate[]> {
  const rows = await db
    .select()
    .from(issuedClientCertificates)
    .orderBy(desc(issuedClientCertificates.createdAt));
  return rows.map(parseIssuedClientCertificate);
}

export async function getIssuedClientCertificate(
  id: number,
): Promise<IssuedClientCertificate | null> {
  const record = await db.query.issuedClientCertificates.findFirst({
    where: (table, { eq: compareEq }) => compareEq(table.id, id),
  });
  return record ? parseIssuedClientCertificate(record) : null;
}

export async function createIssuedClientCertificate(
  input: IssuedClientCertificateInput,
  actorUserId: number,
): Promise<IssuedClientCertificate> {
  const now = nowIso();
  const serialNumber = canonicalSerialNumber(input.serialNumber);
  const [record] = await db
    .insert(issuedClientCertificates)
    .values({
      caCertificateId: input.caCertificateId,
      commonName: input.commonName.trim(),
      serialNumber,
      fingerprintSha256: input.fingerprintSha256.trim(),
      certificatePem: input.certificatePem.trim(),
      validFrom: input.validFrom,
      validTo: input.validTo,
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!record) {
    throw domainError("issuedClientCertificateStorageFailed");
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "issued_client_certificate",
    entityId: record.id,
    summary: `Issued client certificate ${input.commonName}`,
    data: {
      caCertificateId: input.caCertificateId,
      serialNumber,
    },
  });
  await applyCaddyConfig();
  return (await getIssuedClientCertificate(record.id))!;
}

export async function revokeIssuedClientCertificate(
  id: number,
  actorUserId: number,
): Promise<IssuedClientCertificate> {
  const existing = await getIssuedClientCertificate(id);
  if (!existing) {
    throw domainError("issuedClientCertificateNotFound");
  }
  if (existing.revokedAt) {
    throw domainError("issuedClientCertificateAlreadyRevoked");
  }

  const revokedAt = nowIso();
  await db
    .update(issuedClientCertificates)
    .set({
      revokedAt,
      updatedAt: revokedAt,
    })
    .where(eq(issuedClientCertificates.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "revoke",
    entityType: "issued_client_certificate",
    entityId: id,
    summary: `Revoked client certificate ${existing.commonName}`,
    data: {
      caCertificateId: existing.caCertificateId,
      serialNumber: existing.serialNumber,
    },
  });
  await applyCaddyConfig();
  return (await getIssuedClientCertificate(id))!;
}
