/**
 * Which writes wait for approval, and who may give it. No server imports: the policy form and the
 * docs read it. Off by default; while on, an administrator can still apply a request at once with
 * a reason (an emergency bypass), which is audited and alerted.
 */

import { hostTagProblem, hostTagText } from "../proxy-hosts/tag-rules";

/** What a policy can name. Each change kind belongs to exactly one (./kinds.ts). */
export const APPROVAL_AREAS = ["hosts", "accessLists", "waf", "settings"] as const;
export type ApprovalArea = (typeof APPROVAL_AREAS)[number];

/** `tags` covers only host changes, where the host carries one of the tags before or after. */
export const APPROVAL_SCOPES = ["everything", "areas", "tags"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

export type ApprovalPolicy = {
  enabled: boolean;
  scope: ApprovalScope;
  areas: ApprovalArea[];
  tags: string[];
  /** Role keys whose holders may approve; a group's role counts. */
  approverRoles: string[];
  approverGroupIds: number[];
  requiredApprovals: 1 | 2;
  /**
   * On: a covered write over the API waits too, attributed to the token's owner. Off: it applies at
   * once and its audit event says approval was skipped. On by default, or a token walks around it.
   */
  applyToTokens: boolean;
};

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  enabled: false,
  scope: "everything",
  areas: [],
  tags: [],
  approverRoles: ["admin"],
  approverGroupIds: [],
  requiredApprovals: 1,
  applyToTokens: true,
};

export const APPROVAL_POLICY_KEY = "change_approval_policy";
export const MAX_APPROVER_ENTRIES = 50;
export const MAX_POLICY_TAGS = 50;
export const BYPASS_REASON_MAX_LENGTH = 500;
export const DECISION_NOTE_MAX_LENGTH = 500;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Whatever is stored, read leniently: an unknown value falls back rather than failing open. */
export function readApprovalPolicy(stored: unknown): ApprovalPolicy {
  const raw =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const scope = APPROVAL_SCOPES.includes(raw.scope as ApprovalScope)
    ? (raw.scope as ApprovalScope)
    : DEFAULT_APPROVAL_POLICY.scope;
  const ids = Array.isArray(raw.approverGroupIds) ? raw.approverGroupIds : [];
  return {
    enabled: raw.enabled === true,
    scope,
    areas: [...new Set(strings(raw.areas))].filter((area): area is ApprovalArea =>
      APPROVAL_AREAS.includes(area as ApprovalArea),
    ),
    tags: [...new Set(strings(raw.tags).map(hostTagText))]
      .filter(Boolean)
      .slice(0, MAX_POLICY_TAGS),
    approverRoles: Array.isArray(raw.approverRoles)
      ? [...new Set(strings(raw.approverRoles))].slice(0, MAX_APPROVER_ENTRIES)
      : DEFAULT_APPROVAL_POLICY.approverRoles,
    approverGroupIds: [
      ...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)),
    ].slice(0, MAX_APPROVER_ENTRIES),
    requiredApprovals: raw.requiredApprovals === 2 ? 2 : 1,
    applyToTokens: raw.applyToTokens !== false,
  };
}

/** Null when the policy can be saved; otherwise the `errors.*` code that says why not. */
export function approvalPolicyProblem(
  policy: ApprovalPolicy,
):
  | "approvalPolicyNoApprovers"
  | "approvalPolicyNoAreas"
  | "approvalPolicyNoTags"
  | "approvalPolicyTagInvalid"
  | null {
  if (!policy.enabled) return null;
  if (policy.approverRoles.length === 0 && policy.approverGroupIds.length === 0) {
    return "approvalPolicyNoApprovers";
  }
  if (policy.scope === "areas" && policy.areas.length === 0) return "approvalPolicyNoAreas";
  if (policy.scope === "tags" && policy.tags.length === 0) return "approvalPolicyNoTags";
  if (policy.tags.some((tag) => hostTagProblem(tag) !== null)) {
    return "approvalPolicyTagInvalid";
  }
  return null;
}

/** Whether a change in `area` touching hosts tagged `tags` waits for approval. */
export function policyCovers(
  policy: ApprovalPolicy,
  area: ApprovalArea,
  tags: readonly string[],
): boolean {
  if (!policy.enabled) return false;
  if (policy.scope === "everything") return true;
  if (policy.scope === "areas") return policy.areas.includes(area);
  const wanted = new Set(policy.tags);
  return area === "hosts" && tags.some((tag) => wanted.has(hostTagText(tag)));
}
