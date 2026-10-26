/**
 * WAF override mode: a host's WAF runs in detection for one address for a few minutes, the rules
 * it trips are read back from the event log, and the chosen ones go into a preset the host then
 * selects - never into the host's own directives, so the result can be seen, reused and removed
 * as one thing. Client safe: the host page renders a session and its result from these types.
 */

import { ANOMALY_EVALUATION_RULE_IDS, explainWafEvent } from "./event-detail";
import { PROTECTED_RULE_IDS } from "./exclusions";

export const WAF_OVERRIDE_DURATION_MS = 5 * 60_000;

/** Events the agent relays after Finish still belong to the session. */
export const WAF_OVERRIDE_RESULT_GRACE_MS = 90_000;

/** Above every CRS range and below the exclusions' base; one block of ids per session. */
export const WAF_OVERRIDE_RULE_ID_BASE = 1_800_000_000;
export const WAF_OVERRIDE_RULES_PER_SESSION = 1000;

/** The rows of one session, as stored. */
export type WafOverrideSession = {
  id: number;
  proxyHostId: number;
  clientIp: string;
  startedAt: string;
  expiresAt: string;
  /** Null while it runs. */
  endedAt: string | null;
  /** The preset its chosen rules went into; null until applied. */
  presetId: number | null;
};

export function isWafOverrideActive(session: WafOverrideSession, now = Date.now()): boolean {
  return session.endedAt === null && Date.parse(session.expiresAt) > now;
}

export type WafOverrideMatch = { variable: string | null; data: string | null };

/** One rule the session tripped, over every request that tripped it. */
export type WafOverrideRule = {
  ruleId: number;
  message: string;
  severity: string | null;
  points: number;
  paranoiaLevel: number | null;
  hits: number;
  /** Where it matched, deduplicated and capped. */
  matches: WafOverrideMatch[];
  paths: string[];
};

const MAX_MATCHES = 5;
const MAX_PATHS = 5;

/** What the aggregation reads of a stored event; the model hands it redacted events. */
export type WafOverrideEvent = {
  uri: string;
  rawData: string | null;
  blocked: boolean;
  ruleId: number | null;
  ruleMessage: string | null;
  severity: string | null;
};

function pathOf(uri: string): string {
  return uri.replace(/[?#].*$/s, "") || "/";
}

/**
 * The rules the session's events matched, one row per rule id, most-hit first. The evaluation
 * rules are left out: they sum the others, and the protected ones are among them.
 */
export function collectOverrideRules(
  events: readonly WafOverrideEvent[],
  threshold: number,
): WafOverrideRule[] {
  const rules = new Map<number, WafOverrideRule>();
  for (const event of events) {
    const explanation = explainWafEvent(event.rawData, {
      threshold,
      blocked: event.blocked,
      rule: { ruleId: event.ruleId, message: event.ruleMessage, severity: event.severity },
    });
    const seen = new Set<number>();
    for (const matched of explanation.rules) {
      if (matched.ruleId === null || ANOMALY_EVALUATION_RULE_IDS.includes(matched.ruleId)) continue;
      const row = rules.get(matched.ruleId) ?? {
        ruleId: matched.ruleId,
        message: matched.message,
        severity: matched.severity,
        points: matched.points,
        paranoiaLevel: matched.paranoiaLevel,
        hits: 0,
        matches: [],
        paths: [],
      };
      rules.set(matched.ruleId, row);
      // A chained rule can log twice for one request; a hit is a request.
      if (!seen.has(matched.ruleId)) {
        seen.add(matched.ruleId);
        row.hits++;
      }
      if (!row.message && matched.message) row.message = matched.message;
      const match = { variable: matched.variable, data: matched.data };
      if (
        (match.variable || match.data) &&
        row.matches.length < MAX_MATCHES &&
        !row.matches.some((m) => m.variable === match.variable && m.data === match.data)
      ) {
        row.matches.push(match);
      }
      const path = pathOf(event.uri);
      if (row.paths.length < MAX_PATHS && !row.paths.includes(path)) row.paths.push(path);
    }
  }
  return [...rules.values()].sort((a, b) => b.hits - a.hits || a.ruleId - b.ruleId);
}

export type OverrideRuleSelectionError =
  | "wafOverrideNoRules"
  | "wafOverrideTooManyRules"
  | "wafExclusionRuleIdInvalid"
  | "wafExclusionRuleProtected";

/** Positive whole rule ids, deduplicated, none of them an anomaly decision. */
export function normalizeOverrideRuleIds(value: unknown): {
  ruleIds: number[];
  error: OverrideRuleSelectionError | null;
} {
  if (!Array.isArray(value)) return { ruleIds: [], error: "wafExclusionRuleIdInvalid" };
  const ruleIds = [...new Set(value.map((id) => (typeof id === "string" ? Number(id) : id)))];
  if (ruleIds.length === 0) return { ruleIds: [], error: "wafOverrideNoRules" };
  if (ruleIds.length > WAF_OVERRIDE_RULES_PER_SESSION) {
    return { ruleIds: [], error: "wafOverrideTooManyRules" };
  }
  for (const id of ruleIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > 2_147_483_647) {
      return { ruleIds: [], error: "wafExclusionRuleIdInvalid" };
    }
    if (PROTECTED_RULE_IDS.includes(id)) return { ruleIds: [], error: "wafExclusionRuleProtected" };
  }
  return { ruleIds: ruleIds as number[], error: null };
}

/**
 * The preset's directives: one runtime removal per rule, as a scoped exclusion is written, so
 * the custom-directive allowlist takes it (SecRuleRemoveById would be refused as a mutation) and
 * it runs ahead of the CRS, where a preset is emitted. The ids come from the session's own block,
 * so two such presets selected together never share one.
 */
export function overridePresetDirectives(sessionId: number, ruleIds: readonly number[]): string {
  const base = WAF_OVERRIDE_RULE_ID_BASE + sessionId * WAF_OVERRIDE_RULES_PER_SESSION;
  return ruleIds
    .slice(0, WAF_OVERRIDE_RULES_PER_SESSION)
    .map(
      (ruleId, index) =>
        `SecAction "id:${base + index},phase:1,pass,t:none,nolog,ctl:ruleRemoveById=${ruleId}"`,
    )
    .join("\n");
}

/**
 * The route the host gets while a session runs: the tester's address meets the same WAF in
 * detection, logging every transaction a rule marked whatever the response status (the
 * recommended config logs only 4xx and 5xx, and a detected request answers 200); everyone else
 * meets the handler as built. Matched on `client_ip`, which honours the server's trusted
 * proxies, where Coraza's REMOTE_ADDR is the peer.
 */
export function wafOverrideRoute(
  handler: Record<string, unknown>,
  detecting: Record<string, unknown>,
  clientIp: string,
): Record<string, unknown> {
  const directives = `${String(detecting.directives ?? "")}\nSecAuditLogRelevantStatus ".*"`;
  return {
    handler: "subroute",
    routes: [
      {
        match: [{ client_ip: { ranges: [clientIp] } }],
        handle: [{ ...detecting, directives }],
        terminal: true,
      },
      { handle: [handler] },
    ],
  };
}
