import { createHash, randomBytes } from "node:crypto";
import db, { nowIso, toIso } from "../db";
import { logAuditEvent } from "../audit";
import {
  forwardAuthSessions,
  forwardAuthExchanges,
  forwardAuthAccess,
  forwardAuthRedirectIntents,
  groupMembers,
  proxyHosts,
} from "../db/schema";
import { and, asc, eq, gt, inArray, lt, or } from "drizzle-orm";
import { onAnnouncement } from "../cluster/announcements";
import { dropProcessMemo, processMemo } from "../settings/process-memo";
import { hostMatchesPattern } from "../proxy-hosts/pattern-priority";
import { domainError } from "../errors/domain-error";
import { takeFromWindow } from "../auth/rate-limit";

const DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const EXCHANGE_CODE_TTL = 60; // 60 seconds
const REDIRECT_INTENT_TTL = 10 * 60; // 10 minutes - covers login + OAuth flow time

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type ForwardAuthAudience = {
  /** Exact normalized external origin: scheme + hostname + non-default port. */
  origin: string;
  /** Hostname without a port, used only for display/audit messages. */
  hostname: string;
  /** The concrete proxy-host record which authorized the wildcard/exact host. */
  proxyHostId: number;
};

function parseForwardAuthUrlAnyPort(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Ports as the setting lists them; anything that is not one is dropped rather than refused. */
export function parseForwardAuthPortList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((port) => port.trim())
      .filter((port) => /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535)
      .map((port) => String(Number(port))),
  );
}

/** Read per call so a save needs no restart; imported lazily, as in auth/rate-limit.ts. */
async function allowedForwardAuthPorts(): Promise<Set<string>> {
  const [{ forwardAuthAllowedPorts }, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  return parseForwardAuthPortList(await getSetting(forwardAuthAllowedPorts));
}

/** Caddy matches hosts whatever the port, so a non-default one must be declared as served. */
async function isForwardAuthPortAllowed(parsed: URL): Promise<boolean> {
  return !parsed.port || (await allowedForwardAuthPorts()).has(parsed.port);
}

async function parseForwardAuthUrl(rawUrl: string): Promise<URL | null> {
  const parsed = parseForwardAuthUrlAnyPort(rawUrl);
  return parsed && (await isForwardAuthPortAllowed(parsed)) ? parsed : null;
}

// Once per port per window, and capped, so probing many ports cannot flood the log; the window
// restarts hourly, so a port crowded out by probing is still reported later.
let reportedDisallowedPorts = new Set<string>();
let reportWindowStartedAt = 0;
const MAX_REPORTED_DISALLOWED_PORTS = 32;
const DISALLOWED_PORT_REPORT_WINDOW_MS = 60 * 60 * 1000;

function reportDisallowedPort(hostname: string, port: string): void {
  const now = Date.now();
  if (
    now < reportWindowStartedAt ||
    now - reportWindowStartedAt >= DISALLOWED_PORT_REPORT_WINDOW_MS
  ) {
    reportedDisallowedPorts = new Set();
    reportWindowStartedAt = now;
  }
  if (
    reportedDisallowedPorts.has(port) ||
    reportedDisallowedPorts.size >= MAX_REPORTED_DISALLOWED_PORTS
  ) {
    return;
  }
  reportedDisallowedPorts.add(port);
  console.warn(
    `[forward-auth] Rejected ${hostname}:${port} because port ${port} is not an allowed ` +
      `forward-auth port. If protected sites are served on it, add it under Settings > Forward ` +
      `Auth (FORWARD_AUTH_ALLOWED_PORTS).`,
  );
}

function audienceMatchesUrl(audience: ForwardAuthAudience, parsed: URL): boolean {
  return (
    Number.isInteger(audience.proxyHostId) &&
    audience.proxyHostId > 0 &&
    audience.origin === parsed.origin &&
    audience.hostname === parsed.hostname.toLowerCase()
  );
}

// ── Redirect Intents ────────────────────────────────────────────────
// Store redirect URIs server-side so the client only holds an opaque ID.

/** Created by an unauthenticated GET, so bounded across all clients; counted in memory, not by query. */
export const REDIRECT_INTENT_WINDOW_KEY = "forward-auth:redirect-intents";
export const MAX_REDIRECT_INTENTS_PER_WINDOW = 5_000;
export const REDIRECT_INTENT_SWEEP_INTERVAL_MS = 60_000;
let lastIntentSweepAt = 0;

export async function createRedirectIntent(redirectUri: string): Promise<string> {
  // Persist the concrete target now: a wildcard match reduces to the exact origin and host record.
  const audience = await resolveForwardAuthAudience(redirectUri);
  if (!audience) throw domainError("invalidForwardAuthRedirectTarget");
  if (
    !takeFromWindow(
      REDIRECT_INTENT_WINDOW_KEY,
      MAX_REDIRECT_INTENTS_PER_WINDOW,
      REDIRECT_INTENT_TTL * 1000,
    )
  ) {
    throw domainError("tooManyRedirectIntents");
  }

  const rid = randomBytes(16).toString("hex");
  const ridHash = hashToken(rid);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + REDIRECT_INTENT_TTL * 1000).toISOString();

  await db.insert(forwardAuthRedirectIntents).values({
    ridHash,
    proxyHostId: audience.proxyHostId,
    audienceOrigin: audience.origin,
    redirectUri,
    expiresAt,
    consumed: false,
    createdAt: now,
  });

  // At most once per interval, so a GET loop cannot drive the cleanup.
  if (Date.now() - lastIntentSweepAt >= REDIRECT_INTENT_SWEEP_INTERVAL_MS) {
    lastIntentSweepAt = Date.now();
    await db
      .delete(forwardAuthRedirectIntents)
      .where(lt(forwardAuthRedirectIntents.expiresAt, now));
  }

  return rid;
}

/** Whether `rid` names a live intent, without consuming it: a mistyped password must not burn it. */
export async function hasLiveRedirectIntent(rid: string): Promise<boolean> {
  const row = await db.query.forwardAuthRedirectIntents.findFirst({
    columns: { id: true },
    where: (table, operators) =>
      operators.and(
        operators.eq(table.ridHash, hashToken(rid)),
        operators.eq(table.consumed, false),
        operators.gt(table.expiresAt, nowIso()),
      ),
  });
  return row !== undefined;
}

/** True for a dead intent or a gone host: failing open would make a stale rid bypass the gate. */
export async function redirectIntentWantsCaptcha(rid: string): Promise<boolean> {
  const intent = await db.query.forwardAuthRedirectIntents.findFirst({
    columns: { proxyHostId: true },
    where: (table, operators) =>
      operators.and(
        operators.eq(table.ridHash, hashToken(rid)),
        operators.eq(table.consumed, false),
        operators.gt(table.expiresAt, nowIso()),
      ),
  });
  if (!intent?.proxyHostId) return true;
  const host = await db.query.proxyHosts.findFirst({
    columns: { meta: true },
    where: (table, operators) => operators.eq(table.id, intent.proxyHostId as number),
  });
  return host ? parseCpmForwardAuthMeta(host)?.require_captcha !== false : true;
}

export async function consumeRedirectIntent(rid: string): Promise<{
  redirectUri: string;
  audience: ForwardAuthAudience;
} | null> {
  const ridHash = hashToken(rid);
  const now = nowIso();

  // Atomic claim: succeeds only if the intent exists, is unconsumed, and not expired
  const claimed = await db
    .update(forwardAuthRedirectIntents)
    .set({ consumed: true })
    .where(
      and(
        eq(forwardAuthRedirectIntents.ridHash, ridHash),
        eq(forwardAuthRedirectIntents.consumed, false),
        gt(forwardAuthRedirectIntents.expiresAt, now),
      ),
    )
    .returning();

  if (claimed.length === 0) return null;

  const intent = claimed[0];

  await db.delete(forwardAuthRedirectIntents).where(eq(forwardAuthRedirectIntents.id, intent.id));

  const parsed = await parseForwardAuthUrl(intent.redirectUri);
  if (!parsed || !intent.audienceOrigin || !intent.proxyHostId) return null;

  const audience: ForwardAuthAudience = {
    origin: intent.audienceOrigin,
    hostname: parsed.hostname.toLowerCase(),
    proxyHostId: intent.proxyHostId,
  };
  if (!audienceMatchesUrl(audience, parsed)) return null;

  // Fail closed if the proxy-host mapping changed between creation and use.
  const currentAudience = await resolveForwardAuthAudience(intent.redirectUri);
  if (
    !currentAudience ||
    currentAudience.origin !== audience.origin ||
    currentAudience.proxyHostId !== audience.proxyHostId
  ) {
    return null;
  }

  return { redirectUri: intent.redirectUri, audience };
}

// ── Sessions ─────────────────────────────────────────────────────────

export type ForwardAuthSession = {
  id: number;
  userId: number;
  proxyHostId: number;
  audienceOrigin: string;
  expiresAt: string;
  createdAt: string;
};

export async function createForwardAuthSession(
  userId: number,
  audience: ForwardAuthAudience,
  ttlSeconds?: number,
): Promise<{ rawToken: string; session: ForwardAuthSession }> {
  const parsedAudience = await parseForwardAuthUrl(audience.origin);
  if (!parsedAudience || !audienceMatchesUrl(audience, parsedAudience)) {
    throw domainError("invalidForwardAuthAudience");
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const now = nowIso();
  const ttl = ttlSeconds ?? DEFAULT_SESSION_TTL;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const [row] = await db
    .insert(forwardAuthSessions)
    .values({
      userId,
      proxyHostId: audience.proxyHostId,
      audienceOrigin: audience.origin,
      tokenHash,
      expiresAt,
      createdAt: now,
    })
    .returning();

  if (!row) throw domainError("forwardAuthSessionCreationFailed");

  return {
    rawToken,
    session: {
      id: row.id,
      userId: row.userId,
      proxyHostId: row.proxyHostId,
      audienceOrigin: row.audienceOrigin,
      expiresAt: toIso(row.expiresAt)!,
      createdAt: toIso(row.createdAt)!,
    },
  };
}

/**
 * Rows only a presented token would otherwise remove: a browser that never comes back, or a
 * sign-in abandoned before its exchange code was redeemed. ISO strings compare in time order.
 */
export async function pruneExpiredForwardAuthRows(now = new Date()): Promise<void> {
  const at = now.toISOString();
  await db.delete(forwardAuthSessions).where(lt(forwardAuthSessions.expiresAt, at));
  await db.delete(forwardAuthExchanges).where(lt(forwardAuthExchanges.expiresAt, at));
}

export async function validateForwardAuthSession(
  rawToken: string,
  audience: ForwardAuthAudience,
): Promise<{ sessionId: number; userId: number } | null> {
  const tokenHash = hashToken(rawToken);
  const session = await db.query.forwardAuthSessions.findFirst({
    where: (table, operators) => operators.eq(table.tokenHash, tokenHash),
  });

  if (!session) return null;
  if (new Date(session.expiresAt) <= new Date()) return null;
  if (session.proxyHostId !== audience.proxyHostId || session.audienceOrigin !== audience.origin) {
    return null;
  }

  return { sessionId: session.id, userId: session.userId };
}

export async function listForwardAuthSessions(): Promise<ForwardAuthSession[]> {
  const rows = await db.query.forwardAuthSessions.findMany({
    where: (table, operators) => operators.gt(table.expiresAt, nowIso()),
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    proxyHostId: r.proxyHostId,
    audienceOrigin: r.audienceOrigin,
    expiresAt: toIso(r.expiresAt)!,
    createdAt: toIso(r.createdAt)!,
  }));
}

export async function deleteForwardAuthSession(id: number): Promise<void> {
  await db.delete(forwardAuthSessions).where(eq(forwardAuthSessions.id, id));
}

export async function deleteUserForwardAuthSessions(userId: number): Promise<void> {
  await db.delete(forwardAuthSessions).where(eq(forwardAuthSessions.userId, userId));
}

// ── Exchange Codes ───────────────────────────────────────────────────

export async function createExchangeCode(
  sessionId: number,
  redirectUri: string,
  audience: ForwardAuthAudience,
): Promise<{ rawCode: string }> {
  const parsedRedirect = await parseForwardAuthUrl(redirectUri);
  if (!parsedRedirect || !audienceMatchesUrl(audience, parsedRedirect)) {
    throw domainError("invalidForwardAuthAudience");
  }

  const session = await db.query.forwardAuthSessions.findFirst({
    where: (table, operators) => operators.eq(table.id, sessionId),
  });
  if (
    !session ||
    session.proxyHostId !== audience.proxyHostId ||
    session.audienceOrigin !== audience.origin
  ) {
    throw domainError("forwardAuthSessionAudienceMismatch");
  }

  const rawCode = randomBytes(32).toString("hex");
  const codeHash = hashToken(rawCode);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + EXCHANGE_CODE_TTL * 1000).toISOString();

  await db.insert(forwardAuthExchanges).values({
    sessionId,
    proxyHostId: audience.proxyHostId,
    audienceOrigin: audience.origin,
    codeHash,
    sessionToken: "[pending]", // placeholder - fresh token generated at redemption
    redirectUri,
    expiresAt,
    used: false,
    createdAt: now,
  });

  return { rawCode };
}

export async function redeemExchangeCode(
  rawCode: string,
  audience: ForwardAuthAudience,
): Promise<{ sessionId: number; redirectUri: string; rawSessionToken: string } | null> {
  const codeHash = hashToken(rawCode);
  const now = nowIso();

  // Atomic claim: succeeds only if the exchange exists, is unused, and not expired
  const claimed = await db
    .update(forwardAuthExchanges)
    .set({ used: true })
    .where(
      and(
        eq(forwardAuthExchanges.codeHash, codeHash),
        eq(forwardAuthExchanges.proxyHostId, audience.proxyHostId),
        eq(forwardAuthExchanges.audienceOrigin, audience.origin),
        eq(forwardAuthExchanges.used, false),
        gt(forwardAuthExchanges.expiresAt, now),
      ),
    )
    .returning();

  if (claimed.length === 0) return null;
  const exchange = claimed[0];

  const parsedRedirect = await parseForwardAuthUrl(exchange.redirectUri);
  if (!parsedRedirect || !audienceMatchesUrl(audience, parsedRedirect)) {
    await db.delete(forwardAuthExchanges).where(eq(forwardAuthExchanges.id, exchange.id));
    return null;
  }

  // Generate a fresh session token (never stored in the exchange table)
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  const updatedSessions = await db
    .update(forwardAuthSessions)
    .set({ tokenHash })
    .where(
      and(
        eq(forwardAuthSessions.id, exchange.sessionId),
        eq(forwardAuthSessions.proxyHostId, audience.proxyHostId),
        eq(forwardAuthSessions.audienceOrigin, audience.origin),
        gt(forwardAuthSessions.expiresAt, now),
      ),
    )
    .returning({ id: forwardAuthSessions.id });

  await db.delete(forwardAuthExchanges).where(eq(forwardAuthExchanges.id, exchange.id));

  if (updatedSessions.length === 0) return null;

  return {
    sessionId: exchange.sessionId,
    redirectUri: exchange.redirectUri,
    rawSessionToken: rawToken,
  };
}

// ── Host Access Control ──────────────────────────────────────────────

export type ForwardAuthAccessEntry = {
  id: number;
  proxyHostId: number;
  userId: number | null;
  groupId: number | null;
  createdAt: string;
};

/**
 * One round trip: forward auth's verify runs this on every proxied request. No user lookup, since
 * deleting a user or a membership cascades to the rows matched here.
 */
export async function checkHostAccess(userId: number, proxyHostId: number): Promise<boolean> {
  const memberships = db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  const [row] = await db
    .select({ id: forwardAuthAccess.id })
    .from(forwardAuthAccess)
    .where(
      and(
        eq(forwardAuthAccess.proxyHostId, proxyHostId),
        or(eq(forwardAuthAccess.userId, userId), inArray(forwardAuthAccess.groupId, memberships)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function getForwardAuthAccessForHost(
  proxyHostId: number,
): Promise<ForwardAuthAccessEntry[]> {
  const rows = await db
    .select()
    .from(forwardAuthAccess)
    .where(eq(forwardAuthAccess.proxyHostId, proxyHostId));

  return rows.map((r) => ({
    id: r.id,
    proxyHostId: r.proxyHostId,
    userId: r.userId,
    groupId: r.groupId,
    createdAt: toIso(r.createdAt)!,
  }));
}

export async function setForwardAuthAccess(
  proxyHostId: number,
  access: { userIds?: number[]; groupIds?: number[] },
  actorUserId: number,
): Promise<ForwardAuthAccessEntry[]> {
  await db.delete(forwardAuthAccess).where(eq(forwardAuthAccess.proxyHostId, proxyHostId));

  const now = nowIso();
  const values: Array<{
    proxyHostId: number;
    userId: number | null;
    groupId: number | null;
    createdAt: string;
  }> = [];

  for (const uid of access.userIds ?? []) {
    values.push({ proxyHostId, userId: uid, groupId: null, createdAt: now });
  }
  for (const gid of access.groupIds ?? []) {
    values.push({ proxyHostId, userId: null, groupId: gid, createdAt: now });
  }

  if (values.length > 0) {
    await db.insert(forwardAuthAccess).values(values);
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "forward_auth_access",
    entityId: proxyHostId,
    summary: `Updated forward auth access for proxy host ${proxyHostId}`,
  });

  return getForwardAuthAccessForHost(proxyHostId);
}

// ── Domain Validation ────────────────────────────────────────────────

function parseCpmForwardAuthMeta(ph: { meta: string | null }): Record<string, unknown> | null {
  try {
    const parsedMeta = ph.meta ? JSON.parse(ph.meta) : {};
    return (parsedMeta?.cpm_forward_auth as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

function hasForwardAuthEnabled(ph: { meta: string | null }): boolean {
  return !!parseCpmForwardAuthMeta(ph)?.enabled;
}

type ForwardAuthHostEntry = { id: number; domains: string[]; forwardAuth: boolean };

const ENABLED_HOSTS = "forward_auth_enabled_hosts";

// Caddy asks on every request to a protected host, so the table is read once per change, not per
// request. Every host write ends in an apply, which announces "proxy-hosts"; restore and import
// clear every memo through the settings cache.
onAnnouncement("proxy-hosts", () => dropProcessMemo(ENABLED_HOSTS));

function loadEnabledHosts(): Promise<ForwardAuthHostEntry[]> {
  return processMemo(ENABLED_HOSTS, async () => {
    const rows = await db
      .select({ id: proxyHosts.id, domains: proxyHosts.domains, meta: proxyHosts.meta })
      .from(proxyHosts)
      .where(eq(proxyHosts.enabled, true))
      .orderBy(asc(proxyHosts.id));
    return rows.flatMap((ph) => {
      let domains: string[];
      try {
        domains = (JSON.parse(ph.domains) as string[]).map((d) => d.toLowerCase());
      } catch {
        return [];
      }
      return [{ id: ph.id, domains, forwardAuth: hasForwardAuthEnabled(ph) }];
    });
  });
}

async function findForwardAuthProxyHost(host: string): Promise<{ id: number } | null> {
  const allHosts = await loadEnabledHosts();

  // An exact host decides alone, never falling back to a wildcard - as Caddy routes it.
  let exactMatchFound = false;
  let wildcardMatch: ForwardAuthHostEntry | null = null;
  const hostLower = host.toLowerCase();

  for (const ph of allHosts) {
    if (ph.domains.includes(hostLower)) {
      exactMatchFound = true;
      if (ph.forwardAuth) return ph;
      continue;
    }
    if (!wildcardMatch && ph.domains.some((d) => hostMatchesPattern(host, d))) {
      wildcardMatch = ph;
    }
  }

  if (!exactMatchFound && wildcardMatch) {
    return wildcardMatch.forwardAuth ? wildcardMatch : null;
  }

  return null;
}

/** The audience always holds the concrete origin visited, never a wildcard pattern. */
export async function resolveForwardAuthAudience(
  targetUrl: string,
): Promise<ForwardAuthAudience | null> {
  const parsed = parseForwardAuthUrlAnyPort(targetUrl);
  if (!parsed) return null;

  const proxyHost = await findForwardAuthProxyHost(parsed.hostname);
  if (!proxyHost) return null;

  // After the host lookup, so only a port on a protected host is worth a warning.
  if (!(await isForwardAuthPortAllowed(parsed))) {
    reportDisallowedPort(parsed.hostname, parsed.port);
    return null;
  }

  return {
    origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    proxyHostId: proxyHost.id,
  };
}

export async function isForwardAuthDomain(host: string): Promise<boolean> {
  return !!(await findForwardAuthProxyHost(host));
}

/** The port of a forward-auth URL refused only for being undeclared, so the portal can say why. */
export async function getDisallowedForwardAuthPort(targetUrl: string): Promise<string | null> {
  const parsed = parseForwardAuthUrlAnyPort(targetUrl);
  if (!parsed || (await isForwardAuthPortAllowed(parsed))) return null;
  if (!(await findForwardAuthProxyHost(parsed.hostname))) return null;
  reportDisallowedPort(parsed.hostname, parsed.port);
  return parsed.port;
}
