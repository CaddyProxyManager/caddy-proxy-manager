/**
 * What a revision names that may have been deleted since: its certificate, access lists, agents,
 * and the CAs, client certificates and roles its mTLS trusts. Each is listed rather than silently
 * dropped, since dropping a pin or a CA changes what the host does.
 */

import { inArray } from "drizzle-orm";
import db from "../db";
import {
  accessLists,
  agents,
  caCertificates,
  certificates,
  issuedClientCertificates,
  mtlsRoles,
} from "../db/schema";
import type { DomainErrorDetail } from "../errors/domain-error";
import type { HostSnapshot } from "./record";
import type { HostKind, HostReferenceKind, MissingReference } from "./types";

type Meta = {
  mtls?: {
    ca_certificate_ids?: unknown;
    trusted_client_cert_ids?: unknown;
    trusted_role_ids?: unknown;
  };
  location_rules?: { access_list_id?: unknown }[];
};

const MTLS_KEYS = {
  caCertificate: "ca_certificate_ids",
  clientCertificate: "trusted_client_cert_ids",
  mtlsRole: "trusted_role_ids",
} as const;

const TABLES = {
  certificate: certificates,
  accessList: accessLists,
  agent: agents,
  caCertificate: caCertificates,
  clientCertificate: issuedClientCertificates,
  mtlsRole: mtlsRoles,
} as const;

function parseMeta(raw: unknown): Meta {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Meta) : {};
  } catch {
    return {};
  }
}

const ids = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : [];

const one = (value: unknown): number[] => (Number.isInteger(value) ? [value as number] : []);

/** Every id a snapshot names, by kind. */
export function referencedIds(
  kind: HostKind,
  snapshot: HostSnapshot,
): Record<HostReferenceKind, number[]> {
  const meta = parseMeta(snapshot.row.meta);
  const lists = [
    ...one(snapshot.row.accessListId),
    ...(kind === "http"
      ? (meta.location_rules ?? []).flatMap((rule) => one(rule.access_list_id))
      : []),
  ];
  const mtls = kind === "http" ? (meta.mtls ?? {}) : {};
  return {
    certificate: kind === "http" ? one(snapshot.row.certificateId) : [],
    accessList: [...new Set(lists)],
    agent: [...new Set(snapshot.agentIds)],
    caCertificate: ids(mtls.ca_certificate_ids),
    clientCertificate: ids(mtls.trusted_client_cert_ids),
    mtlsRole: ids(mtls.trusted_role_ids),
  };
}

export async function missingReferences(
  kind: HostKind,
  snapshot: HostSnapshot,
): Promise<MissingReference[]> {
  const wanted = referencedIds(kind, snapshot);
  const missing: MissingReference[] = [];
  for (const [refKind, refIds] of Object.entries(wanted) as [HostReferenceKind, number[]][]) {
    if (refIds.length === 0) continue;
    const table = TABLES[refKind];
    const found = await db.select({ id: table.id }).from(table).where(inArray(table.id, refIds));
    const present = new Set(found.map((row) => row.id));
    for (const id of refIds) if (!present.has(id)) missing.push({ kind: refKind, id });
  }
  return missing;
}

/** The snapshot with each missing reference taken out, for an operator who chose to go on. */
export function withoutMissing(snapshot: HostSnapshot, missing: MissingReference[]): HostSnapshot {
  if (missing.length === 0) return snapshot;
  const gone = (refKind: HostReferenceKind, id: unknown) =>
    missing.some((ref) => ref.kind === refKind && ref.id === id);
  const row = { ...snapshot.row };
  if (gone("certificate", row.certificateId)) row.certificateId = null;
  if (gone("accessList", row.accessListId)) row.accessListId = null;
  const meta = parseMeta(row.meta) as Meta & Record<string, unknown>;
  if (typeof row.meta === "string") {
    if (meta.location_rules) {
      meta.location_rules = meta.location_rules.map((rule) => {
        if (!gone("accessList", rule.access_list_id)) return rule;
        const { access_list_id: _dropped, ...rest } = rule;
        return rest;
      });
    }
    if (meta.mtls) {
      const mtls = { ...meta.mtls } as Record<string, unknown>;
      for (const [refKind, key] of Object.entries(MTLS_KEYS) as [HostReferenceKind, string][]) {
        if (Array.isArray(mtls[key])) {
          mtls[key] = ids(mtls[key]).filter((id) => !gone(refKind, id));
        }
      }
      meta.mtls = mtls;
    }
    row.meta = JSON.stringify(meta);
  }
  return { row, agentIds: snapshot.agentIds.filter((id) => !gone("agent", id)) };
}

/** For a refusal: each reference as its own sentence, rendered in the reader's language. */
export function missingReferenceDetails(missing: MissingReference[]): DomainErrorDetail[] {
  const codes = {
    certificate: "hostReferenceCertificate",
    accessList: "hostReferenceAccessList",
    agent: "hostReferenceAgent",
    caCertificate: "hostReferenceCaCertificate",
    clientCertificate: "hostReferenceClientCertificate",
    mtlsRole: "hostReferenceMtlsRole",
  } as const;
  return missing.map((ref) => ({ code: codes[ref.kind], params: { id: ref.id } }));
}
