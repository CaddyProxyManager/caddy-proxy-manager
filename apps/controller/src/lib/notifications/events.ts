/**
 * What the administrators are emailed about. Data only: each kind is rendered from
 * `email.notifications.*`, so no sentence is built here and the catalog holds every language's.
 */

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
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

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
  /** Settings' "send a test notification"; belongs to no category, so no switch stops it. */
  | { kind: "test" };

export type NotificationKind = NotificationEvent["kind"];

const CATEGORY: Record<Exclude<NotificationKind, "test">, NotificationCategory> = {
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
};

export function categoryOf(event: NotificationEvent): NotificationCategory | null {
  return event.kind === "test" ? null : CATEGORY[event.kind];
}
