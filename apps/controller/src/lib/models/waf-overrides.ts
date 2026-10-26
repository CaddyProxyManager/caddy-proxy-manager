/**
 * WAF override sessions (lib/waf/override.ts). One per host at a time; the Caddy build reads the
 * active ones, the security sweep ends the expired ones, and the result is read from the event
 * log rather than stored.
 */

import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { isIP } from "node:net";
import db, { nowIso, toIso } from "../db";
import { wafOverrideSessions } from "../db/schema";
import { logAuditEvent } from "../audit";
import { applyCaddyConfig } from "../caddy";
import { CaddyApplyError } from "../caddy/apply-error";
import { isAnalyticsEnabled } from "../clickhouse/client";
import { domainError } from "../errors/domain-error";
import { hostTrafficNames } from "../proxy-hosts/traffic-status";
import { getWafSettings } from "../settings";
import { resolveEffectiveWaf } from "../waf/caddy";
import {
  WAF_OVERRIDE_DURATION_MS,
  WAF_OVERRIDE_RESULT_GRACE_MS,
  type WafOverrideRule,
  type WafOverrideSession,
  collectOverrideRules,
  isLoopbackIp,
  isWafOverrideActive,
  normalizeOverrideRuleIds,
  overridePresetDirectives,
} from "../waf/override";
import { effectiveTuning } from "../waf/tuning";
import { getProxyHost, updateProxyHost } from "./proxy-hosts";
import { listWafEvents } from "./waf-events";
import { type WafPreset, createWafPreset, getWafPreset } from "./waf-presets";

type Row = typeof wafOverrideSessions.$inferSelect;

function toSession(row: Row): WafOverrideSession {
  return {
    id: row.id,
    proxyHostId: row.proxyHostId,
    clientIp: row.clientIp,
    startedAt: toIso(row.startedAt)!,
    expiresAt: toIso(row.expiresAt)!,
    endedAt: toIso(row.endedAt),
    presetId: row.presetId ?? null,
  };
}

/** The host's latest session, running or not; null when it never had one. */
export async function getWafOverride(proxyHostId: number): Promise<WafOverrideSession | null> {
  const [row] = await db
    .select()
    .from(wafOverrideSessions)
    .where(eq(wafOverrideSessions.proxyHostId, proxyHostId))
    .orderBy(desc(wafOverrideSessions.id))
    .limit(1);
  return row ? toSession(row) : null;
}

async function getSession(id: number): Promise<WafOverrideSession> {
  const row = await db.query.wafOverrideSessions.findFirst({
    where: (table, { eq: same }) => same(table.id, id),
  });
  if (!row) throw domainError("wafOverrideNotFound", {}, { status: 404 });
  return toSession(row);
}

/** For the Caddy build: host id -> the address its WAF only detects for. */
export async function activeWafOverridesByHost(
  now = Date.now(),
): Promise<ReadonlyMap<number, string>> {
  const rows = await db
    .select()
    .from(wafOverrideSessions)
    .where(isNull(wafOverrideSessions.endedAt));
  const active = new Map<number, string>();
  for (const row of rows) {
    if (isWafOverrideActive(toSession(row), now)) active.set(row.proxyHostId, row.clientIp);
  }
  return active;
}

/**
 * Applies after a write; a config Caddy refuses is undone so the host never stays on a route it
 * cannot load. An unreachable Caddy keeps the write, which the monitor applies once it is back.
 */
async function applyOrRollBack(undo: () => Promise<void>): Promise<void> {
  try {
    await applyCaddyConfig();
  } catch (error) {
    if (!(error instanceof CaddyApplyError) || error.code !== "CADDY_REJECTED") return;
    await undo();
    try {
      await applyCaddyConfig();
    } catch (reapplyError) {
      console.error("[waf] re-applying after a refused override failed:", reapplyError);
    }
    throw domainError("wafOverrideRejected", {}, { status: 400 });
  }
}

/**
 * Switches the host's WAF to detection for `clientIp` for the next five minutes. Refused while
 * the host's WAF would not block anyway, without the event log to read the result from, or while
 * a session already runs.
 */
export async function startWafOverride(
  proxyHostId: number,
  clientIp: string | null,
  actorUserId: number,
): Promise<WafOverrideSession> {
  const host = await getProxyHost(proxyHostId);
  if (!host) throw domainError("wafOverrideHostNotFound", {}, { status: 404 });
  const effective = resolveEffectiveWaf(await getWafSettings(), host.waf);
  if (!effective?.enabled || effective.mode !== "On") {
    throw domainError("wafOverrideWafOff", {}, { status: 400 });
  }
  if (!(await isAnalyticsEnabled())) {
    throw domainError("wafOverrideNeedsAnalytics", {}, { status: 400 });
  }
  if (!clientIp || !isIP(clientIp)) {
    throw domainError("wafOverrideAddressUnknown", {}, { status: 400 });
  }
  if (isLoopbackIp(clientIp)) {
    throw domainError("wafOverrideAddressLoopback", { ip: clientIp }, { status: 400 });
  }
  const now = Date.now();
  const current = await getWafOverride(proxyHostId);
  if (current && isWafOverrideActive(current, now)) {
    throw domainError("wafOverrideAlreadyRunning", {}, { status: 409 });
  }
  const [record] = await db
    .insert(wafOverrideSessions)
    .values({
      proxyHostId,
      clientIp,
      startedBy: actorUserId,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + WAF_OVERRIDE_DURATION_MS).toISOString(),
    })
    .returning();
  await applyOrRollBack(async () => {
    await db.delete(wafOverrideSessions).where(eq(wafOverrideSessions.id, record.id));
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "waf_override_started",
    entityType: "proxy_host",
    entityId: proxyHostId,
    summary: `Started WAF override mode on proxy host ${host.name}`,
    data: { clientIp, expiresAt: record.expiresAt },
  });
  return toSession(record);
}

/** Ends the running session now and puts the host's WAF back to blocking. */
export async function finishWafOverride(
  proxyHostId: number,
  actorUserId: number,
): Promise<WafOverrideSession> {
  const current = await getWafOverride(proxyHostId);
  if (!current || !isWafOverrideActive(current)) {
    throw domainError("wafOverrideNotRunning", {}, { status: 409 });
  }
  const [record] = await db
    .update(wafOverrideSessions)
    .set({ endedAt: nowIso() })
    .where(eq(wafOverrideSessions.id, current.id))
    .returning();
  await applyCaddyConfig();
  const host = await getProxyHost(proxyHostId);
  await logAuditEvent({
    userId: actorUserId,
    action: "waf_override_finished",
    entityType: "proxy_host",
    entityId: proxyHostId,
    summary: `Finished WAF override mode on proxy host ${host?.name ?? proxyHostId}`,
  });
  return toSession(record);
}

/** The sweep's half: ends every session past its time and re-applies if any was. */
export async function expireWafOverrides(now = Date.now()): Promise<number> {
  const expired = await db
    .update(wafOverrideSessions)
    .set({ endedAt: wafOverrideSessions.expiresAt })
    .where(
      and(
        isNull(wafOverrideSessions.endedAt),
        lte(wafOverrideSessions.expiresAt, new Date(now).toISOString()),
      ),
    )
    .returning({ id: wafOverrideSessions.id });
  if (expired.length > 0) await applyCaddyConfig();
  return expired.length;
}

/** Drops an ended session nothing was made from, so the host page offers a fresh start. */
export async function discardWafOverride(sessionId: number): Promise<void> {
  const session = await getSession(sessionId);
  if (isWafOverrideActive(session)) throw domainError("wafOverrideNotEnded", {}, { status: 409 });
  if (session.presetId !== null) {
    throw domainError("wafOverrideAlreadyApplied", {}, { status: 409 });
  }
  await db.delete(wafOverrideSessions).where(eq(wafOverrideSessions.id, sessionId));
}

export type WafOverrideResult = {
  session: WafOverrideSession;
  rules: WafOverrideRule[];
  /** How many of the host's stored events the rules came from. */
  events: number;
  /** The preset the rules went into, once applied. */
  preset: Pick<WafPreset, "id" | "name"> | null;
};

const RESULT_EVENT_LIMIT = 500;

/**
 * What the session tripped so far: the host's events from the tester's address since it started,
 * up to a little past its end so rows the agent relays late still count.
 */
export async function getWafOverrideResult(sessionId: number): Promise<WafOverrideResult> {
  const session = await getSession(sessionId);
  const host = await getProxyHost(session.proxyHostId);
  if (!host) throw domainError("wafOverrideHostNotFound", {}, { status: 404 });
  const from = Math.floor(Date.parse(session.startedAt) / 1000);
  const end = session.endedAt ? Date.parse(session.endedAt) + WAF_OVERRIDE_RESULT_GRACE_MS : null;
  const to = Math.ceil(Math.min(end ?? Number.POSITIVE_INFINITY, Date.now()) / 1000);
  const settings = await getWafSettings();
  const threshold = effectiveTuning(settings).inboundThreshold;
  const events = (
    await Promise.all(
      hostTrafficNames(host.domains).map((name) =>
        listWafEvents(RESULT_EVENT_LIMIT, 0, { host: name, clientIp: session.clientIp }, from, to),
      ),
    )
  ).flat();
  const preset = session.presetId === null ? null : await getWafPreset(session.presetId);
  return {
    session,
    rules: collectOverrideRules(events, threshold),
    events: events.length,
    preset: preset ? { id: preset.id, name: preset.name } : null,
  };
}

export type WafOverrideApplyInput = {
  sessionId: number;
  name: string;
  ruleIds: number[];
};

/**
 * The chosen rules into a new preset, which the host then selects beside what it already had.
 * Never the host's own directives: the result stays one named thing to review or remove.
 */
export async function applyWafOverride(
  input: WafOverrideApplyInput,
  actorUserId: number,
): Promise<{ session: WafOverrideSession; preset: WafPreset }> {
  const session = await getSession(input.sessionId);
  if (isWafOverrideActive(session)) throw domainError("wafOverrideNotEnded", {}, { status: 409 });
  if (session.presetId !== null) {
    throw domainError("wafOverrideAlreadyApplied", {}, { status: 409 });
  }
  const host = await getProxyHost(session.proxyHostId);
  if (!host) throw domainError("wafOverrideHostNotFound", {}, { status: 404 });
  const { ruleIds, error } = normalizeOverrideRuleIds(input.ruleIds);
  if (error) throw domainError(error, {}, { status: 400 });

  const preset = await createWafPreset(
    {
      name: input.name,
      description: `Rules ${host.name} tripped in WAF override mode on ${session.startedAt.slice(0, 10)}`,
      directives: overridePresetDirectives(session.id, ruleIds),
    },
    actorUserId,
  );
  // The preset is global and the host is what selects it; a refused host write leaves the preset,
  // which the WAF page lists and can delete.
  const presetIds = [...new Set([...(host.waf?.preset_ids ?? []), preset.id])];
  await updateProxyHost(host.id, { waf: { ...host.waf, preset_ids: presetIds } }, actorUserId);
  const [record] = await db
    .update(wafOverrideSessions)
    .set({ presetId: preset.id })
    .where(eq(wafOverrideSessions.id, session.id))
    .returning();
  await logAuditEvent({
    userId: actorUserId,
    action: "waf_override_applied",
    entityType: "proxy_host",
    entityId: host.id,
    summary: `Applied WAF override mode results on proxy host ${host.name}`,
    data: { presetId: preset.id, presetName: preset.name, ruleIds },
  });
  return { session: toSession(record), preset };
}
