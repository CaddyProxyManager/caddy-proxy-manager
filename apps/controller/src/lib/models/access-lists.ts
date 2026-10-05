import { hashBcrypt } from "../auth/password";

/**
 * Caddy's http_basic verifies these itself, so they stay bcrypt though user passwords moved to
 * argon2id. Cost 10, not 12, because Caddy re-verifies on every proxied request.
 */
const ACCESS_LIST_COST = 10;
import db, { nowIso, runInTransaction, toIso } from "../db";
import { applyCaddyConfig } from "../caddy";
import { auditEventRow, logAuditEvent } from "../audit";
import {
  accessListEntries,
  accessListIpRules,
  accessLists,
  auditEvents,
  l4ProxyHosts,
  proxyHosts,
} from "../db/schema";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { domainError } from "../errors/domain-error";
import { getDashboardSettings } from "../settings";
import {
  ACCESS_LIST_SATISFY,
  type AccessListSatisfy,
  type DenyResponse,
  IP_RULE_ACTIONS,
  type IpRule,
  type IpRuleAction,
  hostnameRanges,
  sanitizeDenyResponse,
  sanitizeIpRules,
  splitRuleHostname,
} from "../access-lists/rules";
import {
  type HostnameResolution,
  SAVE_TIMEOUT_MS,
  lookupNames,
  readHostnameResolutions,
  resolveHostnames,
} from "../access-lists/dns";

export type AccessListEntry = {
  id: number;
  username: string;
  createdAt: string;
  updatedAt: string;
};

/** Where a hostname rule stands: the ranges it puts in Caddy's config, and why it has none. */
export type HostnameRuleStatus = {
  ranges: string[];
  resolvedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

/** `resolved` only on a hostname rule. */
export type AccessListIpRule = IpRule & { resolved?: HostnameRuleStatus };

export type AccessList = {
  id: number;
  name: string;
  description: string | null;
  entries: AccessListEntry[];
  /** In the order they're checked. */
  ipRules: AccessListIpRule[];
  ipDefault: IpRuleAction;
  satisfy: AccessListSatisfy;
  passAuth: boolean;
  /** Null is the plain 403. */
  denyResponse: DenyResponse | null;
  failClosed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AccessListInput = {
  name: string;
  description?: string | null;
  users?: { username: string; password: string }[];
  ipRules?: unknown;
  ipDefault?: unknown;
  satisfy?: unknown;
  passAuth?: unknown;
  denyResponse?: unknown;
  failClosed?: unknown;
};

export type AccessListSettingsInput = {
  name?: string;
  description?: string | null;
  ipDefault?: unknown;
  satisfy?: unknown;
  passAuth?: unknown;
  /** Null restores the plain 403. */
  denyResponse?: unknown;
  failClosed?: unknown;
};

type AccessListRow = typeof accessLists.$inferSelect;
type AccessListEntryRow = typeof accessListEntries.$inferSelect;
type AccessListIpRuleRow = typeof accessListIpRules.$inferSelect;

function parseIpDefault(value: unknown): IpRuleAction {
  if (!(IP_RULE_ACTIONS as readonly unknown[]).includes(value)) {
    throw domainError("accessListIpDefaultInvalid", {}, { status: 400 });
  }
  return value as IpRuleAction;
}

function parseSatisfy(value: unknown): AccessListSatisfy {
  if (!(ACCESS_LIST_SATISFY as readonly unknown[]).includes(value)) {
    throw domainError("accessListSatisfyInvalid", {}, { status: 400 });
  }
  return value as AccessListSatisfy;
}

function buildEntry(row: AccessListEntryRow): AccessListEntry {
  return {
    id: row.id,
    username: row.username,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

function toIpRule(
  rule: AccessListIpRuleRow,
  resolutions: Map<string, HostnameResolution>,
): AccessListIpRule {
  const base: IpRule = {
    action: rule.action === "allow" ? "allow" : "deny",
    cidr: rule.cidr,
    hostname: rule.hostname,
    country: rule.country,
    continent: rule.continent,
    asn: rule.asn,
    note: rule.note,
    expiresAt: rule.expiresAt,
  };
  if (!rule.hostname) return base;
  const { name, ipv6Prefix } = splitRuleHostname(rule.hostname);
  const found = resolutions.get(name);
  return {
    ...base,
    resolved: {
      ranges: hostnameRanges(found?.addresses ?? [], ipv6Prefix),
      resolvedAt: found?.resolvedAt ?? null,
      lastError: found?.lastError ?? null,
      lastErrorAt: found?.lastErrorAt ?? null,
    },
  };
}

function denyResponseOf(row: AccessListRow): DenyResponse | null {
  if (row.denyRedirectUrl) return { status: 302, body: null, redirectUrl: row.denyRedirectUrl };
  if (row.denyStatus == null && !row.denyBody) return null;
  return { status: row.denyStatus ?? 403, body: row.denyBody, redirectUrl: null };
}

function denyColumns(deny: DenyResponse | null) {
  return {
    denyStatus: deny && !deny.redirectUrl ? deny.status : null,
    denyBody: deny?.body ?? null,
    denyRedirectUrl: deny?.redirectUrl ?? null,
  };
}

function toAccessList(
  row: AccessListRow,
  entries: AccessListEntryRow[],
  ipRules: AccessListIpRuleRow[],
  resolutions: Map<string, HostnameResolution>,
): AccessList {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    entries: entries
      .slice()
      .sort((a, b) => a.username.localeCompare(b.username))
      .map(buildEntry),
    ipRules: ipRules
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((rule) => toIpRule(rule, resolutions)),
    ipDefault: row.ipDefault === "allow" ? "allow" : "deny",
    satisfy: row.satisfy === "any" ? "any" : "all",
    passAuth: row.passAuth,
    denyResponse: denyResponseOf(row),
    failClosed: row.failClosed,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

export async function listAccessLists(): Promise<AccessList[]> {
  const lists = await db.query.accessLists.findMany({
    orderBy: (table) => asc(table.name),
  });

  if (lists.length === 0) {
    return [];
  }

  const listIds = lists.map((list) => list.id);
  const entries = await db
    .select()
    .from(accessListEntries)
    .where(inArray(accessListEntries.accessListId, listIds));

  const entriesByList = new Map<number, AccessListEntryRow[]>();
  for (const entry of entries) {
    const bucket = entriesByList.get(entry.accessListId) ?? [];
    bucket.push(entry);
    entriesByList.set(entry.accessListId, bucket);
  }
  const rules = await db
    .select()
    .from(accessListIpRules)
    .where(inArray(accessListIpRules.accessListId, listIds));
  const rulesByList = new Map<number, AccessListIpRuleRow[]>();
  for (const rule of rules) {
    const bucket = rulesByList.get(rule.accessListId) ?? [];
    bucket.push(rule);
    rulesByList.set(rule.accessListId, bucket);
  }
  const resolutions = await readHostnameResolutions(lookupNames(rules.map((r) => r.hostname)));

  return lists.map((list) =>
    toAccessList(
      list,
      entriesByList.get(list.id) ?? [],
      rulesByList.get(list.id) ?? [],
      resolutions,
    ),
  );
}

/** What the L4 host editor offers: at layer 4 only the rules apply, so it needs their count. */
export type L4AccessListOption = { id: number; name: string; ipRuleCount: number };

export async function listL4AccessListOptions(): Promise<L4AccessListOption[]> {
  const [lists, rules] = await Promise.all([
    db
      .select({ id: accessLists.id, name: accessLists.name })
      .from(accessLists)
      .orderBy(asc(accessLists.name)),
    db.select({ accessListId: accessListIpRules.accessListId }).from(accessListIpRules),
  ]);
  const counts = new Map<number, number>();
  for (const rule of rules) counts.set(rule.accessListId, (counts.get(rule.accessListId) ?? 0) + 1);
  return lists.map((list) => ({ ...list, ipRuleCount: counts.get(list.id) ?? 0 }));
}

export async function getAccessList(id: number): Promise<AccessList | null> {
  const list = await db.query.accessLists.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
  });
  if (!list) {
    return null;
  }
  const [entries, rules] = await Promise.all([
    db
      .select()
      .from(accessListEntries)
      .where(eq(accessListEntries.accessListId, id))
      .orderBy(asc(accessListEntries.username)),
    db
      .select()
      .from(accessListIpRules)
      .where(eq(accessListIpRules.accessListId, id))
      .orderBy(asc(accessListIpRules.sortOrder)),
  ]);
  const resolutions = await readHostnameResolutions(lookupNames(rules.map((r) => r.hostname)));
  return toAccessList(list, entries, rules, resolutions);
}

/**
 * Names no cache entry knows are looked up before the apply, so a new rule works on save rather
 * than at the refresher's next pass. Briefly: an answer that is slow is left to the refresher.
 */
async function resolveNewHostnames(rules: IpRule[]): Promise<void> {
  const names = lookupNames(rules.map((rule) => rule.hostname));
  const known = await readHostnameResolutions(names);
  await resolveHostnames(
    names.filter((name) => !known.has(name)),
    { timeoutMs: SAVE_TIMEOUT_MS },
  );
}

export async function createAccessList(input: AccessListInput, actorUserId: number) {
  const now = nowIso();
  // Validated before anything is written, so a bad rule leaves no half-made list behind.
  const ipRules = input.ipRules === undefined ? [] : sanitizeIpRules(input.ipRules);
  const ipDefault = input.ipDefault === undefined ? "deny" : parseIpDefault(input.ipDefault);
  const satisfy = input.satisfy === undefined ? "all" : parseSatisfy(input.satisfy);
  const deny = sanitizeDenyResponse(input.denyResponse);

  const [accessList] = await db
    .insert(accessLists)
    .values({
      name: input.name.trim(),
      description: input.description ?? null,
      ipDefault,
      satisfy,
      passAuth: input.passAuth === true,
      ...denyColumns(deny),
      failClosed: input.failClosed === true,
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!accessList) {
    throw domainError("failedToCreateAccessList");
  }

  if (input.users && input.users.length > 0) {
    const entryRows = await Promise.all(
      input.users.map(async (account) => ({
        accessListId: accessList.id,
        username: account.username,
        passwordHash: await hashBcrypt(account.password, ACCESS_LIST_COST),
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(accessListEntries).values(entryRows);
  }
  if (ipRules.length > 0) {
    await db.insert(accessListIpRules).values(ipRuleRows(accessList.id, ipRules, now));
    await resolveNewHostnames(ipRules);
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "access_list",
    entityId: accessList.id,
    summary: `Created access list ${input.name}`,
  });

  await applyCaddyConfig();
  return (await getAccessList(accessList.id))!;
}

function ipRuleRows(accessListId: number, rules: IpRule[], now: string) {
  return rules.map((rule, index) => ({
    accessListId,
    action: rule.action,
    cidr: rule.cidr,
    hostname: rule.hostname,
    country: rule.country ?? null,
    continent: rule.continent ?? null,
    asn: rule.asn ?? null,
    note: rule.note,
    expiresAt: rule.expiresAt ?? null,
    sortOrder: index,
    createdAt: now,
    updatedAt: now,
  }));
}

export async function updateAccessList(
  id: number,
  input: AccessListSettingsInput,
  actorUserId: number,
) {
  const existing = await getAccessList(id);
  if (!existing) {
    throw domainError("accessListNotFound");
  }

  const now = nowIso();
  const deny =
    input.denyResponse === undefined ? undefined : sanitizeDenyResponse(input.denyResponse);
  await db
    .update(accessLists)
    .set({
      name: input.name ?? existing.name,
      // `undefined` keeps it; null or blank clears it, which `??` alone could never do.
      description:
        input.description === undefined ? existing.description : input.description?.trim() || null,
      ipDefault:
        input.ipDefault === undefined ? existing.ipDefault : parseIpDefault(input.ipDefault),
      satisfy: input.satisfy === undefined ? existing.satisfy : parseSatisfy(input.satisfy),
      passAuth: input.passAuth === undefined ? existing.passAuth : input.passAuth === true,
      ...(deny === undefined ? {} : denyColumns(deny)),
      failClosed: input.failClosed === undefined ? existing.failClosed : input.failClosed === true,
      updatedAt: now,
    })
    .where(eq(accessLists.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "access_list",
    entityId: id,
    summary: `Updated access list ${input.name ?? existing.name}`,
  });

  await applyCaddyConfig();
  return (await getAccessList(id))!;
}

export async function addAccessListEntry(
  accessListId: number,
  entry: { username: string; password: string },
  actorUserId: number,
) {
  const list = await db.query.accessLists.findFirst({
    where: (table, operators) => operators.eq(table.id, accessListId),
  });
  if (!list) {
    throw domainError("accessListNotFound");
  }

  const now = nowIso();
  const hash = await hashBcrypt(entry.password, ACCESS_LIST_COST);
  await db.insert(accessListEntries).values({
    accessListId,
    username: entry.username,
    passwordHash: hash,
    createdAt: now,
    updatedAt: now,
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "access_list_entry",
    entityId: accessListId,
    summary: `Added user ${entry.username} to access list ${list.name}`,
  });
  await applyCaddyConfig();
  return (await getAccessList(accessListId))!;
}

export async function setAccessListIpRules(id: number, rules: unknown, actorUserId: number) {
  const existing = await db.query.accessLists.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
  });
  if (!existing) {
    throw domainError("accessListNotFound");
  }
  const sanitized = sanitizeIpRules(rules);
  if (sanitized.length === 0) {
    // At layer 4 the rules are all of the list, so emptying them would close every connection.
    const l4Hosts = (await getAccessListUsageMap()).get(id)?.filter((h) => h.kind === "l4") ?? [];
    if (l4Hosts.length > 0) {
      throw domainError(
        "accessListIpRulesNeededByL4Hosts",
        { hosts: l4Hosts.map((host) => host.name) },
        { status: 409 },
      );
    }
  }
  const now = nowIso();
  await runInTransaction((tx) => [
    tx.delete(accessListIpRules).where(eq(accessListIpRules.accessListId, id)),
    ...(sanitized.length > 0
      ? [tx.insert(accessListIpRules).values(ipRuleRows(id, sanitized, now))]
      : []),
    tx.update(accessLists).set({ updatedAt: now }).where(eq(accessLists.id, id)),
  ]);
  await resolveNewHostnames(sanitized);

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "access_list",
    entityId: id,
    summary: `Updated access list ${existing.name}`,
  });
  await applyCaddyConfig();
  return (await getAccessList(id))!;
}

export async function removeAccessListEntry(
  accessListId: number,
  entryId: number,
  actorUserId: number,
) {
  const list = await db.query.accessLists.findFirst({
    where: (table, operators) => operators.eq(table.id, accessListId),
  });
  if (!list) {
    throw domainError("accessListNotFound");
  }

  // Scoped to the list: an entry id from another list must not be deletable through this one.
  const removed = await db
    .delete(accessListEntries)
    .where(and(eq(accessListEntries.id, entryId), eq(accessListEntries.accessListId, accessListId)))
    .returning({ id: accessListEntries.id });
  if (removed.length === 0) {
    throw domainError("accessListEntryNotFound");
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "access_list_entry",
    entityId: entryId,
    summary: `Removed entry from access list ${list.name}`,
  });
  await applyCaddyConfig();
  return (await getAccessList(accessListId))!;
}

/** All or nothing, one apply: an id from another list refuses the batch. */
export async function removeAccessListEntries(
  accessListId: number,
  entryIds: number[],
  actorUserId: number,
) {
  const list = await db.query.accessLists.findFirst({
    where: (table, operators) => operators.eq(table.id, accessListId),
  });
  if (!list) {
    throw domainError("accessListNotFound");
  }
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return (await getAccessList(accessListId))!;

  const scoped = and(
    inArray(accessListEntries.id, ids),
    eq(accessListEntries.accessListId, accessListId),
  );
  const found = await db.select({ id: accessListEntries.id }).from(accessListEntries).where(scoped);
  if (found.length !== ids.length) {
    throw domainError("accessListEntryNotFound");
  }

  await runInTransaction((tx) => [
    tx.delete(accessListEntries).where(scoped),
    tx.insert(auditEvents).values(
      ids.map((entryId) =>
        auditEventRow({
          userId: actorUserId,
          action: "delete",
          entityType: "access_list_entry",
          entityId: entryId,
          summary: `Removed entry from access list ${list.name}`,
          data: { bulk: true },
        }),
      ),
    ),
  ]);
  await applyCaddyConfig();
  return (await getAccessList(accessListId))!;
}

export async function deleteAccessList(id: number, actorUserId: number) {
  const existing = await db.query.accessLists.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
  });
  if (!existing) {
    throw domainError("accessListNotFound");
  }
  await assertAccessListUnused(id);

  await db.delete(accessLists).where(eq(accessLists.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "access_list",
    entityId: id,
    summary: `Deleted access list ${existing.name}`,
  });
  await applyCaddyConfig();
}

/**
 * The host's foreign key is `set null` and a location rule's null means "no list", so either
 * would quietly unprotect whatever the list guarded. A delete is refused instead.
 */
async function assertAccessListUnused(id: number): Promise<void> {
  const [usage, dashboard] = await Promise.all([getAccessListUsageMap(), getDashboardSettings()]);
  const hosts = usage.get(id) ?? [];
  if (hosts.length > 0) {
    throw domainError(
      "accessListInUseByHosts",
      { hosts: hosts.map((host) => host.name) },
      { status: 409 },
    );
  }
  // Counted while the dashboard host is off too: turning it back on would come up unprotected.
  const options = dashboard?.options;
  if (options && listIdsNamedBy(options.accessListId, options.meta).has(id)) {
    throw domainError("accessListInUseByDashboard", {}, { status: 409 });
  }
}

/** The host's own list and any a location rule on it names. */
function listIdsNamedBy(accessListId: number | null, meta: string | null): Set<number> {
  const listIds = new Set<number>();
  if (accessListId != null) listIds.add(accessListId);
  try {
    const parsed = meta ? JSON.parse(meta) : {};
    for (const rule of parsed.location_rules ?? []) {
      if (typeof rule.access_list_id === "number") listIds.add(rule.access_list_id);
    }
  } catch {
    // Unreadable meta names no lists.
  }
  return listIds;
}

export type AccessListUsage = {
  /** Unique per kind only. */
  id: number;
  kind: "proxy" | "l4";
  name: string;
  /** An L4 host's listen address, which is all it has for a name on the wire. */
  domains: string[];
  enabled: boolean;
};

export async function getAccessListUsageMap(): Promise<Map<number, AccessListUsage[]>> {
  const rows = await db
    .select({
      id: proxyHosts.id,
      name: proxyHosts.name,
      domains: proxyHosts.domains,
      enabled: proxyHosts.enabled,
      accessListId: proxyHosts.accessListId,
      meta: proxyHosts.meta,
    })
    .from(proxyHosts);

  const map = new Map<number, AccessListUsage[]>();
  for (const row of rows) {
    // Each list counts the host once, however many of its rules name it.
    const listIds = listIdsNamedBy(row.accessListId, row.meta);
    if (listIds.size === 0) continue;
    const usage: AccessListUsage = {
      id: row.id,
      kind: "proxy",
      name: row.name,
      domains: JSON.parse(row.domains),
      enabled: row.enabled,
    };
    for (const listId of listIds) {
      const bucket = map.get(listId) ?? [];
      bucket.push(usage);
      map.set(listId, bucket);
    }
  }
  const l4Rows = await db
    .select({
      id: l4ProxyHosts.id,
      name: l4ProxyHosts.name,
      listenAddress: l4ProxyHosts.listenAddress,
      enabled: l4ProxyHosts.enabled,
      accessListId: l4ProxyHosts.accessListId,
    })
    .from(l4ProxyHosts);
  for (const row of l4Rows) {
    if (row.accessListId == null) continue;
    const bucket = map.get(row.accessListId) ?? [];
    bucket.push({
      id: row.id,
      kind: "l4",
      name: row.name,
      domains: [row.listenAddress],
      enabled: row.enabled,
    });
    map.set(row.accessListId, bucket);
  }
  return map;
}

/** Deletes rules past their expiry, one audit event per list, and applies once. */
export async function pruneExpiredAccessListRules(
  now = Date.now(),
  applyConfig: () => Promise<void> = applyCaddyConfig,
): Promise<number> {
  const expired = await db
    .select({
      id: accessListIpRules.id,
      accessListId: accessListIpRules.accessListId,
      name: accessLists.name,
    })
    .from(accessListIpRules)
    .innerJoin(accessLists, eq(accessLists.id, accessListIpRules.accessListId))
    .where(
      and(
        isNotNull(accessListIpRules.expiresAt),
        lte(accessListIpRules.expiresAt, new Date(now).toISOString()),
      ),
    );
  if (expired.length === 0) return 0;
  const byList = new Map<number, { name: string; count: number }>();
  for (const row of expired) {
    const entry = byList.get(row.accessListId) ?? { name: row.name, count: 0 };
    entry.count += 1;
    byList.set(row.accessListId, entry);
  }
  await runInTransaction((tx) => [
    tx.delete(accessListIpRules).where(
      inArray(
        accessListIpRules.id,
        expired.map((row) => row.id),
      ),
    ),
    tx.insert(auditEvents).values(
      [...byList].map(([listId, { name, count }]) =>
        auditEventRow({
          userId: null,
          action: "update",
          entityType: "access_list",
          entityId: listId,
          summary: `Expired rules removed from access list ${name} (${count})`,
          data: { expiredRules: count },
        }),
      ),
    ),
  ]);
  await applyConfig();
  return expired.length;
}

export type AccessListStats = {
  /** Proxy and L4 hosts naming the list, location rules included. */
  hosts: number;
  /** Null with analytics off or unreachable. */
  traffic: { stopped: number; failedSignIns: number } | null;
};

/** Over the last 24 hours. */
export async function getAccessListStats(id: number, now = Date.now()): Promise<AccessListStats> {
  const usage = (await getAccessListUsageMap()).get(id) ?? [];
  const [{ isAnalyticsEnabled }, { queryAccessListTraffic }, { hostTrafficNames }] =
    await Promise.all([
      import("../clickhouse/client"),
      import("../clickhouse/access-list-stats"),
      import("../proxy-hosts/traffic-status"),
    ]);
  let traffic: AccessListStats["traffic"] = null;
  try {
    if (await isAnalyticsEnabled()) {
      const to = Math.floor(now / 1000);
      const names = hostTrafficNames(
        usage.filter((host) => host.kind === "proxy").flatMap((host) => host.domains),
      );
      traffic = await queryAccessListTraffic({ from: to - 86400, to }, names);
    }
  } catch (error) {
    console.warn("[access-lists] could not read a list's traffic:", error);
  }
  return { hosts: usage.length, traffic };
}
