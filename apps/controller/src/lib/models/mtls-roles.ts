import db, { nowIso, toIso } from "../db";
import { applyCaddyConfig } from "../caddy";
import { logAuditEvent } from "../audit";
import { mtlsRoles, mtlsCertificateRoles, issuedClientCertificates } from "../db/schema";
import { asc, eq, inArray, count, and, isNull } from "drizzle-orm";
import { isCertificateUnexpired, normalizeFingerprint } from "../caddy/mtls";
import { domainError } from "../errors/domain-error";

// ── Types ────────────────────────────────────────────────────────────

export type MtlsRole = {
  id: number;
  name: string;
  description: string | null;
  certificateCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MtlsRoleInput = {
  name: string;
  description?: string | null;
};

export type MtlsRoleWithCertificates = MtlsRole & {
  certificateIds: number[];
};

// ── Helpers ──────────────────────────────────────────────────────────

type RoleRow = typeof mtlsRoles.$inferSelect;

async function countCertsForRole(roleId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(mtlsCertificateRoles)
    .where(eq(mtlsCertificateRoles.mtlsRoleId, roleId));
  return row?.value ?? 0;
}

function toMtlsRole(row: RoleRow, certCount: number): MtlsRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    certificateCount: certCount,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

export async function listMtlsRoles(): Promise<MtlsRole[]> {
  const rows = await db.query.mtlsRoles.findMany({
    orderBy: (table) => asc(table.name),
  });
  if (rows.length === 0) return [];

  const roleIds = rows.map((r) => r.id);
  const counts = await db
    .select({
      roleId: mtlsCertificateRoles.mtlsRoleId,
      cnt: count(),
    })
    .from(mtlsCertificateRoles)
    .where(inArray(mtlsCertificateRoles.mtlsRoleId, roleIds))
    .groupBy(mtlsCertificateRoles.mtlsRoleId);

  const countMap = new Map(counts.map((c) => [c.roleId, c.cnt]));
  return rows.map((r) => toMtlsRole(r, countMap.get(r.id) ?? 0));
}

export async function getMtlsRole(id: number): Promise<MtlsRoleWithCertificates | null> {
  const row = await db.query.mtlsRoles.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  if (!row) return null;

  const assignments = await db
    .select({ certId: mtlsCertificateRoles.issuedClientCertificateId })
    .from(mtlsCertificateRoles)
    .where(eq(mtlsCertificateRoles.mtlsRoleId, id));

  return {
    ...toMtlsRole(row, assignments.length),
    certificateIds: assignments.map((a) => a.certId),
  };
}

export async function createMtlsRole(input: MtlsRoleInput, actorUserId: number): Promise<MtlsRole> {
  const now = nowIso();
  const [record] = await db
    .insert(mtlsRoles)
    .values({
      name: input.name.trim(),
      description: input.description ?? null,
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!record) throw domainError("failedToCreateMtlsRole");

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "mtls_role",
    entityId: record.id,
    summary: `Created mTLS role ${input.name}`,
  });

  return toMtlsRole(record, 0);
}

export async function updateMtlsRole(
  id: number,
  input: Partial<MtlsRoleInput>,
  actorUserId: number,
): Promise<MtlsRole> {
  const existing = await db.query.mtlsRoles.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  if (!existing) throw domainError("mtlsRoleNotFound");

  const now = nowIso();
  await db
    .update(mtlsRoles)
    .set({
      name: input.name?.trim() ?? existing.name,
      description:
        input.description !== undefined ? (input.description ?? null) : existing.description,
      updatedAt: now,
    })
    .where(eq(mtlsRoles.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "mtls_role",
    entityId: id,
    summary: `Updated mTLS role ${input.name?.trim() ?? existing.name}`,
  });

  await applyCaddyConfig();
  const certCount = await countCertsForRole(id);
  const updated = await db.query.mtlsRoles.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  return toMtlsRole(updated!, certCount);
}

export async function deleteMtlsRole(id: number, actorUserId: number): Promise<void> {
  const existing = await db.query.mtlsRoles.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  if (!existing) throw domainError("mtlsRoleNotFound");

  await db.delete(mtlsRoles).where(eq(mtlsRoles.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "mtls_role",
    entityId: id,
    summary: `Deleted mTLS role ${existing.name}`,
  });

  await applyCaddyConfig();
}

// ── Certificate ↔ Role assignments ───────────────────────────────────

export async function assignRoleToCertificate(
  roleId: number,
  certId: number,
  actorUserId: number,
): Promise<void> {
  const role = await db.query.mtlsRoles.findFirst({
    where: (t, { eq: cmpEq }) => cmpEq(t.id, roleId),
  });
  if (!role) throw domainError("mtlsRoleNotFound");

  const cert = await db.query.issuedClientCertificates.findFirst({
    where: (t, { eq: cmpEq }) => cmpEq(t.id, certId),
  });
  if (!cert) throw domainError("issuedClientCertificateNotFound");

  const now = nowIso();
  await db.insert(mtlsCertificateRoles).values({
    issuedClientCertificateId: certId,
    mtlsRoleId: roleId,
    createdAt: now,
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "assign",
    entityType: "mtls_certificate_role",
    entityId: roleId,
    summary: `Assigned cert ${cert.commonName} to role ${role.name}`,
    data: { roleId, certId },
  });

  await applyCaddyConfig();
}

export async function removeRoleFromCertificate(
  roleId: number,
  certId: number,
  actorUserId: number,
): Promise<void> {
  const role = await db.query.mtlsRoles.findFirst({
    where: (t, { eq: cmpEq }) => cmpEq(t.id, roleId),
  });
  if (!role) throw domainError("mtlsRoleNotFound");

  await db
    .delete(mtlsCertificateRoles)
    .where(
      and(
        eq(mtlsCertificateRoles.mtlsRoleId, roleId),
        eq(mtlsCertificateRoles.issuedClientCertificateId, certId),
      ),
    );

  await logAuditEvent({
    userId: actorUserId,
    action: "unassign",
    entityType: "mtls_certificate_role",
    entityId: roleId,
    summary: `Removed cert from role ${role.name}`,
    data: { roleId, certId },
  });

  await applyCaddyConfig();
}

export async function getCertificateRoles(certId: number): Promise<MtlsRole[]> {
  const assignments = await db
    .select({ roleId: mtlsCertificateRoles.mtlsRoleId })
    .from(mtlsCertificateRoles)
    .where(eq(mtlsCertificateRoles.issuedClientCertificateId, certId));

  if (assignments.length === 0) return [];

  const roleIds = assignments.map((a) => a.roleId);
  const rows = await db
    .select()
    .from(mtlsRoles)
    .where(inArray(mtlsRoles.id, roleIds))
    .orderBy(asc(mtlsRoles.name));

  return rows.map((r) => toMtlsRole(r, 0));
}

/**
 * Both per-role views of the active role assignments from one query: roleId → Set<certId> and
 * roleId → Set<normalizedFingerprint>. Config generation needs both on every apply.
 */
export async function buildRoleMaps(): Promise<{
  roleCertIdMap: Map<number, Set<number>>;
  roleFingerprintMap: Map<number, Set<string>>;
}> {
  const rows = await db
    .select({
      roleId: mtlsCertificateRoles.mtlsRoleId,
      certId: mtlsCertificateRoles.issuedClientCertificateId,
      fingerprint: issuedClientCertificates.fingerprintSha256,
      validTo: issuedClientCertificates.validTo,
    })
    .from(mtlsCertificateRoles)
    .innerJoin(
      issuedClientCertificates,
      eq(mtlsCertificateRoles.issuedClientCertificateId, issuedClientCertificates.id),
    )
    .where(isNull(issuedClientCertificates.revokedAt));

  const roleCertIdMap = new Map<number, Set<number>>();
  const roleFingerprintMap = new Map<number, Set<string>>();
  const now = Date.now();
  for (const row of rows) {
    if (!isCertificateUnexpired(row.validTo, now)) continue;
    let certIds = roleCertIdMap.get(row.roleId);
    if (!certIds) {
      certIds = new Set();
      roleCertIdMap.set(row.roleId, certIds);
    }
    certIds.add(row.certId);

    let fingerprints = roleFingerprintMap.get(row.roleId);
    if (!fingerprints) {
      fingerprints = new Set();
      roleFingerprintMap.set(row.roleId, fingerprints);
    }
    fingerprints.add(normalizeFingerprint(row.fingerprint));
  }
  return { roleCertIdMap, roleFingerprintMap };
}

/** roleId → Set<normalizedFingerprint> for active certs. Used during config generation. */
export async function buildRoleFingerprintMap(): Promise<Map<number, Set<string>>> {
  return (await buildRoleMaps()).roleFingerprintMap;
}

/** certId → normalizedFingerprint for active certs, for direct cert overrides. */
export async function buildCertFingerprintMap(): Promise<Map<number, string>> {
  const rows = await db
    .select({
      id: issuedClientCertificates.id,
      fingerprint: issuedClientCertificates.fingerprintSha256,
      validTo: issuedClientCertificates.validTo,
    })
    .from(issuedClientCertificates)
    .where(isNull(issuedClientCertificates.revokedAt));

  const map = new Map<number, string>();
  const now = Date.now();
  for (const row of rows) {
    if (!isCertificateUnexpired(row.validTo, now)) continue;
    map.set(row.id, normalizeFingerprint(row.fingerprint));
  }
  return map;
}

/** roleId → Set<certId> for active certs, resolving trusted_role_ids → cert IDs. */
export async function buildRoleCertIdMap(): Promise<Map<number, Set<number>>> {
  return (await buildRoleMaps()).roleCertIdMap;
}

// Re-exported for convenience; normalizeFingerprint's canonical home is caddy/mtls.ts.
export { normalizeFingerprint } from "../caddy/mtls";
