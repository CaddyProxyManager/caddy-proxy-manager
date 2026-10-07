/**
 * What the administrators are emailed about. Data only: each kind is rendered from
 * `email.notifications.*`, so no sentence is built here and the catalog holds every language's.
 */

import type { AttentionCode, AttentionValues } from "../attention/types";
import type { StoredErrorCode } from "../errors/domain-error";
import type { GeoipDownloadFailure } from "../geoip/updater";

export const NOTIFICATION_CATEGORIES = [
  "accountDisabled",
  "adminLocked",
  "adminAdded",
  "agentOffline",
  "upstreamErrors",
  "caddyApply",
  "agentProblems",
  "geoip",
  "crsPlugin",
  "updateAvailable",
  "backups",
  "auditSinks",
  "accessReviews",
  "changeApprovals",
  "channels",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** What a metric rule measures per proxy host: a share is 0-100. */
export const ALERT_METRICS = ["serverErrorShare", "requests", "serverErrors", "mitigated"] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

/** What an agent reports going wrong on its own host. */
export const AGENT_PROBLEMS = ["caddyBuild", "services", "l4Ports", "logAccess"] as const;
export type AgentProblem = (typeof AGENT_PROBLEMS)[number];

/** Strings are whatever the source said, English included (an SMTP or Caddy error). */
export type NotificationEvent =
  | { kind: "accountDisabled"; email: string; failures: number }
  | { kind: "lastAdminKept"; email: string; failures: number }
  | { kind: "adminLocked"; email: string; failures: number }
  | { kind: "adminAdded"; email: string; promoted: boolean }
  | { kind: "agentOffline"; agent: string; minutes: number }
  | { kind: "agentOnline"; agent: string }
  | { kind: "upstreamErrors"; host: string; count: number; minutes: number }
  | { kind: "upstreamRecovered"; host: string }
  /** `errorCode` renders `error` in the reader's language; absent on a notice stored before it. */
  | {
      kind: "caddyApplyFailed";
      agent: string | null;
      error: string;
      errorCode?: StoredErrorCode | null;
    }
  | { kind: "caddyApplyRecovered"; agent: string | null }
  | { kind: "agentProblem"; agent: string; problem: AgentProblem; detail: string | null }
  | { kind: "agentProblemResolved"; agent: string; problem: AgentProblem }
  /** As caddyApplyFailed, with the run's parts in place of one code. */
  | {
      kind: "geoipFailed";
      failures: number;
      error: string;
      checkError?: { message: string; code: StoredErrorCode | null } | null;
      editionFailures?: GeoipDownloadFailure[];
    }
  | { kind: "geoipRecovered" }
  | { kind: "crsPluginDisabled"; plugin: string; version: string }
  | { kind: "updateAvailable"; version: string; current: string }
  /** As caddyApplyFailed: `errorCode` renders `error` in the reader's language. */
  | { kind: "backupFailed"; schedule: string; error: string; errorCode?: StoredErrorCode | null }
  | { kind: "backupRecovered"; schedule: string }
  /** An audit sink that keeps failing, or that fell behind past what pruning keeps. */
  | { kind: "auditSinkFailed"; sink: string; error: string; errorCode?: StoredErrorCode | null }
  | { kind: "auditSinkRecovered"; sink: string }
  /** An access review nearing its due date, or past it, with items nobody has decided. */
  | {
      kind: "accessReviewDue";
      campaignId: number;
      campaign: string;
      pending: number;
      dueOn: string;
    }
  | {
      kind: "accessReviewOverdue";
      campaignId: number;
      campaign: string;
      pending: number;
      dueOn: string;
    }
  /** Closed with revocations an administrator must confirm before they apply. */
  | { kind: "accessReviewConfirm"; campaignId: number; campaign: string; revocations: number }
  /** An administrator applied a change request without its approvals. */
  | {
      kind: "changeApprovalBypassed";
      requestId: number;
      change: string;
      by: string;
      reason: string;
    }
  /** An alert channel whose sends keep failing, reported through the others. */
  | { kind: "channelFailing"; channelId: number; channel: string; failures: number; error: string }
  | { kind: "channelRecovered"; channelId: number; channel: string }
  /** "Send test" on a channel, straight to it; and a test queued through a rule's channels. */
  | { kind: "channelTest"; channel: string }
  | { kind: "ruleTest"; rule: string }
  /** From a rule on Needs attention or a traffic signal: rendered from `attention.items.<code>`. */
  | { kind: "attention"; code: AttentionCode; values: AttentionValues; href: string | null }
  | { kind: "attentionResolved"; code: AttentionCode; values: AttentionValues }
  /** From a rule on a ClickHouse metric over a window, per proxy host. */
  | {
      kind: "metricThreshold";
      host: string;
      metric: AlertMetric;
      comparison: "above" | "below";
      value: number;
      threshold: number;
      minutes: number;
    }
  | { kind: "metricRecovered"; host: string; metric: AlertMetric }
  /** Settings' "send a test notification"; belongs to no category, so no switch stops it. */
  | { kind: "test" };

export type NotificationKind = NotificationEvent["kind"];

/** Kinds with no category, so no Settings switch or mute: rules' own, and the tests. */
export const RULE_KINDS = [
  "attention",
  "attentionResolved",
  "metricThreshold",
  "metricRecovered",
  "channelTest",
  "ruleTest",
] as const satisfies readonly NotificationKind[];
type RuleKind = (typeof RULE_KINDS)[number];

const CATEGORY: Record<Exclude<NotificationKind, "test" | RuleKind>, NotificationCategory> = {
  accountDisabled: "accountDisabled",
  lastAdminKept: "accountDisabled",
  adminLocked: "adminLocked",
  adminAdded: "adminAdded",
  agentOffline: "agentOffline",
  agentOnline: "agentOffline",
  upstreamErrors: "upstreamErrors",
  upstreamRecovered: "upstreamErrors",
  caddyApplyFailed: "caddyApply",
  caddyApplyRecovered: "caddyApply",
  agentProblem: "agentProblems",
  agentProblemResolved: "agentProblems",
  geoipFailed: "geoip",
  geoipRecovered: "geoip",
  crsPluginDisabled: "crsPlugin",
  updateAvailable: "updateAvailable",
  backupFailed: "backups",
  backupRecovered: "backups",
  auditSinkFailed: "auditSinks",
  auditSinkRecovered: "auditSinks",
  accessReviewDue: "accessReviews",
  accessReviewOverdue: "accessReviews",
  accessReviewConfirm: "accessReviews",
  changeApprovalBypassed: "changeApprovals",
  channelFailing: "channels",
  channelRecovered: "channels",
};

export function categoryOf(event: NotificationEvent): NotificationCategory | null {
  return event.kind in CATEGORY ? CATEGORY[event.kind as keyof typeof CATEGORY] : null;
}

/** The kinds an event rule can name: every kind a category raises. */
export const EVENT_KINDS = Object.keys(CATEGORY) as (keyof typeof CATEGORY)[];

/** Kinds that say something is over; chat channels colour them as resolved. */
export const RECOVERY_KINDS: ReadonlySet<NotificationKind> = new Set([
  "agentOnline",
  "upstreamRecovered",
  "caddyApplyRecovered",
  "agentProblemResolved",
  "geoipRecovered",
  "backupRecovered",
  "auditSinkRecovered",
  "channelRecovered",
  "attentionResolved",
  "metricRecovered",
]);

/** The proxy host an event is about, by name, for a rule scoped to hosts or tags. */
export function hostOf(event: NotificationEvent): string | null {
  switch (event.kind) {
    case "upstreamErrors":
    case "upstreamRecovered":
    case "metricThreshold":
    case "metricRecovered":
      return event.host;
    default:
      return null;
  }
}
