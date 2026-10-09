/** One WAF event in full: why it was stopped, the narrowest exclusion for it, and its review. */

import { eq, inArray, lt } from "drizzle-orm";
import db, { nowIso, toIso } from "../db";
import { agents, users, wafEventReviews } from "../db/schema";
import { logAuditEvent } from "../audit";
import { domainError } from "../errors/domain-error";
import { isAnalyticsEnabled } from "../clickhouse/client";
import { queryUserAgentOfWafEvent, queryWafEventsAt } from "../clickhouse/security";
import { type WafEvent, redactStoredWafEvent } from "../models/waf-events";
import { listProxyHosts } from "../models/proxy-hosts";
import { getWafSettings } from "../settings";
import { type WafEventExplanation, explainWafEvent, wafEventCurl } from "../waf/event-detail";
import { wafEventKeyTs } from "../waf/event-key";
import { normalizeExclusionPath, PROTECTED_RULE_IDS } from "../waf/exclusions";
import { effectiveTuning } from "../waf/tuning";

export const WAF_EVENT_VERDICTS = ["intended", "false_positive"] as const;
export type WafEventVerdict = (typeof WAF_EVENT_VERDICTS)[number];

export type WafEventReview = {
  verdict: WafEventVerdict;
  reviewedBy: string | null;
  reviewedAt: string;
};

/** What "False positive" fills the exclusion form with: this rule, here, for this variable. */
export type SuggestedExclusion = {
  ruleId: number;
  proxyHostId: number | null;
  hostName: string | null;
  path: string | null;
  target: string | null;
};

/** The agent whose rows these were; its name only while it is still paired. */
export type WafEventRelay = { agentId: string; name: string | null };

export type WafEventDetail = {
  event: WafEvent;
  relayedBy: WafEventRelay | null;
  /** From the access log; null when the request was not logged. */
  userAgent: string | null;
  explanation: WafEventExplanation;
  suggestedExclusion: SuggestedExclusion | null;
  curl: string;
  review: WafEventReview | null;
};

function pathOf(uri: string): string | null {
  try {
    return normalizeExclusionPath(uri);
  } catch {
    return null;
  }
}

export async function getWafEventDetail(key: string): Promise<WafEventDetail> {
  const ts = wafEventKeyTs(key);
  if (ts === null || !(await isAnalyticsEnabled())) {
    throw domainError("wafEventNotFound", {}, { status: 404 });
  }
  const stored = (await queryWafEventsAt(ts)).find((event) => event.key === key);
  if (!stored) throw domainError("wafEventNotFound", {}, { status: 404 });
  const { relayedBy: relayAgentId, ...storedEvent } = stored;
  const event = redactStoredWafEvent(storedEvent);

  const [settings, hosts, reviews, relay, userAgent] = await Promise.all([
    getWafSettings(),
    listProxyHosts(),
    getWafEventReviews([key]),
    relayAgentId
      ? db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.agentId, relayAgentId))
          .limit(1)
      : Promise.resolve([]),
    queryUserAgentOfWafEvent(event).catch(() => null),
  ]);
  const explanation = explainWafEvent(event.rawData, {
    threshold: effectiveTuning(settings).inboundThreshold,
    blocked: event.blocked,
    rule: { ruleId: event.ruleId, message: event.ruleMessage, severity: event.severity },
  });

  const bareHost = event.host.replace(/:\d+$/, "").toLowerCase();
  const host = hosts.find((candidate) =>
    candidate.domains.some((domain) => domain.toLowerCase() === bareHost),
  );
  // The rule that matched, not the evaluation that summed it, and the variable it matched in.
  const culprit =
    explanation.rules.find((rule) => rule.ruleId !== null && rule.points > 0) ??
    explanation.rules.find((rule) => rule.ruleId !== null);
  const ruleId = culprit?.ruleId ?? event.ruleId;
  const suggestedExclusion =
    ruleId !== null && !PROTECTED_RULE_IDS.includes(ruleId)
      ? {
          ruleId,
          proxyHostId: host?.id ?? null,
          hostName: host?.name ?? null,
          path: pathOf(event.uri),
          target: culprit?.variable ?? null,
        }
      : null;

  return {
    event,
    relayedBy: relayAgentId ? { agentId: relayAgentId, name: relay[0]?.name ?? null } : null,
    userAgent,
    explanation,
    suggestedExclusion,
    curl: wafEventCurl(event.rawData, event),
    review: reviews.get(key) ?? null,
  };
}

export async function getWafEventReviews(
  keys: readonly string[],
): Promise<Map<string, WafEventReview>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ review: wafEventReviews, name: users.name, email: users.email })
    .from(wafEventReviews)
    .leftJoin(users, eq(users.id, wafEventReviews.userId))
    .where(inArray(wafEventReviews.eventKey, [...keys]));
  return new Map(
    rows.map(({ review, name, email }) => [
      review.eventKey,
      {
        verdict: review.verdict as WafEventVerdict,
        reviewedBy: name || email || null,
        reviewedAt: toIso(review.createdAt)!,
      },
    ]),
  );
}

/** Marks an event looked at; a second review replaces the first. Null clears it. */
export async function reviewWafEvent(
  key: string,
  verdict: WafEventVerdict | null,
  actorUserId: number,
): Promise<WafEventReview | null> {
  if (wafEventKeyTs(key) === null) throw domainError("wafEventNotFound", {}, { status: 404 });
  if (verdict !== null && !WAF_EVENT_VERDICTS.includes(verdict)) {
    throw domainError("wafEventVerdictInvalid", {}, { status: 400 });
  }
  await db.delete(wafEventReviews).where(eq(wafEventReviews.eventKey, key));
  if (verdict !== null) {
    await db
      .insert(wafEventReviews)
      .values({ eventKey: key, verdict, userId: actorUserId, createdAt: nowIso() });
  }
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "waf_event",
    entityId: null,
    summary:
      verdict === null
        ? `Cleared the review of WAF event ${key}`
        : verdict === "intended"
          ? `Reviewed WAF event ${key} as working as intended`
          : `Reviewed WAF event ${key} as a false positive`,
  });
  return verdict === null ? null : ((await getWafEventReviews([key])).get(key) ?? null);
}

/** Events outlive their review only until ClickHouse's retention drops them. */
export async function pruneWafEventReviews(olderThanDays: number, now = Date.now()): Promise<void> {
  const cutoff = new Date(now - olderThanDays * 86_400_000).toISOString();
  await db.delete(wafEventReviews).where(lt(wafEventReviews.createdAt, cutoff));
}
