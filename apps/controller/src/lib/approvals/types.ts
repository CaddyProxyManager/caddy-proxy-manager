/**
 * A change request as the approvals page and the API show it. Client safe: codes, not sentences,
 * with `changeApprovals.*` in the catalog rendering them.
 */

import type { AuditChange } from "../audit/changes";
import type { HostChangePreview } from "../host-review/types";
import type { ConfigDiff } from "../settings/config-diff";
import type { ApprovalArea } from "./policy";

/** Every write a policy can hold back, each in one area (./kinds.ts). */
export const CHANGE_KINDS = [
  "proxyHostCreate",
  "proxyHostUpdate",
  "proxyHostDelete",
  "proxyHostMaintenance",
  "proxyHostBulk",
  "forwardAuthAccess",
  "mtlsRuleCreate",
  "mtlsRuleUpdate",
  "mtlsRuleDelete",
  "l4HostCreate",
  "l4HostUpdate",
  "l4HostDelete",
  "l4HostBulk",
  "hostRollback",
  "hostRestore",
  "accessListCreate",
  "accessListUpdate",
  "accessListDelete",
  "accessListRules",
  "accessListEntryAdd",
  "accessListEntryRemove",
  "wafPresetCreate",
  "wafPresetUpdate",
  "wafPresetDelete",
  "wafExclusionCreate",
  "wafExclusionUpdate",
  "wafExclusionDelete",
  "crsPluginInstall",
  "crsPluginUpdate",
  "crsPluginConfig",
  "crsPluginUninstall",
  "settingsApply",
  "settingsGroup",
  "approvalPolicy",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** `applying` is held while one approval applies it, so a second never applies it again. */
export const CHANGE_STATUSES = [
  "pending",
  "applying",
  "applied",
  "failed",
  "rejected",
  "withdrawn",
  "invalidated",
] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export type ChangePreview =
  /** A host editor's own review: the field diff and what the save sets off. */
  | { type: "host"; host: HostChangePreview }
  /** Field-level before and after, secrets masked, as the audit log shows them. */
  | { type: "fields"; changes: AuditChange[] }
  /** Settings: the changed keys and the Caddy config the staged review compares. */
  | { type: "settings"; keys: string[]; changes: AuditChange[]; config: ConfigDiff | null };

export type ChangeDecision = {
  userId: number | null;
  userName: string | null;
  decision: "approve" | "reject";
  note: string | null;
  createdAt: string;
};

export type ChangeRequestView = {
  id: number;
  kind: ChangeKind;
  area: ApprovalArea;
  targetType: string | null;
  targetId: number | null;
  targetName: string | null;
  tags: string[];
  status: ChangeStatus;
  requiredApprovals: number;
  approvals: number;
  requestedBy: number | null;
  requestedByName: string | null;
  viaToken: boolean;
  bypassedByName: string | null;
  bypassReason: string | null;
  resultCode: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
  decisions: ChangeDecision[];
  preview: ChangePreview;
  /** For the viewer: may approve or reject it, withdraw it, or bypass it. */
  mayDecide: boolean;
  mayWithdraw: boolean;
  mayBypass: boolean;
};

export function isChangeKind(value: unknown): value is ChangeKind {
  return typeof value === "string" && (CHANGE_KINDS as readonly string[]).includes(value);
}
