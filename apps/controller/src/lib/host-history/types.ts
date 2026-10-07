/** What the history pages and the API show of a host's revisions. Client safe. */

import type { HostKind } from "../host-review/types";

export type { HostKind };

export const HOST_REVISION_OPERATIONS = [
  "create",
  "update",
  "maintenance",
  "delete",
  "bulk",
  "import",
  "rollback",
  "restore",
] as const;
export type HostRevisionOperation = (typeof HOST_REVISION_OPERATIONS)[number];

/** What a revision may name that can be deleted after it was taken. */
export const HOST_REFERENCE_KINDS = [
  "certificate",
  "accessList",
  "agent",
  "caCertificate",
  "clientCertificate",
  "mtlsRole",
] as const;
export type HostReferenceKind = (typeof HOST_REFERENCE_KINDS)[number];

export type MissingReference = { kind: HostReferenceKind; id: number };

/**
 * `bulk` names its action, `rollback` and `restore` the revision they came from, and any write a
 * change request applied names that request.
 */
export type HostRevisionDetail = {
  action?: string;
  tag?: string;
  revision?: number;
  changeRequest?: number;
};

export type HostRevisionSummary = {
  id: number;
  hostKind: HostKind;
  hostId: number;
  operation: HostRevisionOperation;
  detail: HostRevisionDetail | null;
  userId: number | null;
  userName: string | null;
  createdAt: string;
  /** The host's name in this revision. */
  name: string;
};

/** An audit event's way back to its host's history, ready to roll back or restore. */
export type AuditRevisionLink = { kind: "rollback" | "restore"; href: string };
