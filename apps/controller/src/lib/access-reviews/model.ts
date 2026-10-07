/**
 * The vocabulary of an access review, shared by the server and the page. No server imports.
 */

export const REVIEW_SCOPES = ["allUsers", "role", "group", "grants", "tokens", "scim"] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

/** A role assignment, a group membership, a grant on one object, an API token, a SCIM connection. */
export const ITEM_KINDS = ["role", "membership", "grant", "token", "scimConnection"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const DECISIONS = ["keep", "revoke", "change"] as const;
export type Decision = (typeof DECISIONS)[number];

/** `applying` is held while a closer's revocations run; `confirming` waits for an administrator. */
export const CAMPAIGN_STATUSES = ["open", "applying", "confirming", "closed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const OUTCOMES = ["applied", "failed", "gone"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const HINTS = ["noRecentSignIn", "tokenUnused", "connectionUnused", "groupEmpty"] as const;
export type Hint = (typeof HINTS)[number];

/** How long without a sign-in, or a token or connection without use, before it is pointed out. */
export const HINT_DAYS = 90;

export const CAMPAIGN_NAME_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 500;
export const MAX_REVIEWERS = 50;

/** Only a role can be changed to another, and a grant between view and manage. */
export function canChange(kind: ItemKind): boolean {
  return kind === "role" || kind === "grant";
}

/** A campaign is due at the end of its day, in UTC, so every replica and reader agrees. */
export function dueAt(dueOn: string): number {
  return Date.parse(`${dueOn}T23:59:59.999Z`);
}

export function isOverdue(dueOn: string, now = Date.now()): boolean {
  return now > dueAt(dueOn);
}

export type ReviewCounts = {
  total: number;
  decided: number;
  keep: number;
  revoke: number;
  change: number;
  applied: number;
  failed: number;
};

export type ReviewCampaign = {
  id: number;
  name: string;
  scope: ReviewScope;
  scopeRef: string | null;
  dueOn: string;
  status: CampaignStatus;
  createdBy: number | null;
  createdAt: string;
  closedAt: string | null;
  appliedAt: string | null;
  reviewers: { id: number; label: string }[];
  counts: ReviewCounts;
};

export type ReviewItem = {
  id: number;
  campaignId: number;
  kind: ItemKind;
  userId: number | null;
  groupId: number | null;
  tokenId: number | null;
  connectionId: number | null;
  objectKind: string | null;
  objectId: number | null;
  subjectLabel: string;
  targetLabel: string | null;
  current: string | null;
  hints: Hint[];
  scimManaged: boolean;
  reviewerId: number | null;
  reviewerLabel: string | null;
  decision: Decision | null;
  changeTo: string | null;
  note: string | null;
  decidedAt: string | null;
  outcome: Outcome | null;
  outcomeCode: string | null;
};
