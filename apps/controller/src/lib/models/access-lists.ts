import { hashBcrypt } from "../password";

/**
 * Caddy's http_basic verifies these itself, so they stay bcrypt though user passwords moved to
 * argon2id. Cost 10, not 12, because Caddy re-verifies on every proxied request.
 */
const ACCESS_LIST_COST = 10;
import db, { nowIso, runInTransaction, toIso } from "../db";
import { applyCaddyConfig } from "../caddy";
import { logAuditEvent } from "../audit";
import { accessListEntries, accessListIpRules, accessLists, proxyHosts } from "../db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { domainError } from "../domain-error";
import {
  ACCESS_LIST_SATISFY,
  type AccessListSatisfy,
  IP_RULE_ACTIONS,
  type IpRule,
  type IpRuleAction,
  sanitizeIpRules,
} from "../access-list-rules";

export type AccessListEntry = {
  id: number;
  username: string;
  createdAt: string;
  updatedAt: string;
};

export type AccessList = {
  id: number;
  name: string;
  description: string | null;
  entries: AccessListEntry[];
  /** In the order they're checked. */
  ipRules: IpRule[];
  ipDefault: IpRuleAction;
  satisfy: AccessListSatisfy;
  passAuth: boolean;
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
};

export type AccessListSettingsInput = {
  name?: string;
  description?: string | null;
  ipDefault?: unknown;
  satisfy?: unknown;
  passAuth?: unknown;
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

function toAccessList(
  row: AccessListRow,
  entries: AccessListEntryRow[],
  ipRules: AccessListIpRuleRow[],
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
      .map((rule) => ({
        action: rule.action === "allow" ? "allow" : "deny",
        cidr: rule.cidr,
        note: rule.note,
      })),
    ipDefault: row.ipDefault === "allow" ? "allow" : "deny",
    satisfy: row.satisfy === "any" ? "any" : "all",
    passAuth: row.passAuth,
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

  return lists.map((list) =>
    toAccessList(list, entriesByList.get(list.id) ?? [], rulesByList.get(list.id) ?? []),
  );
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
  return toAccessList(list, entries, rules);
}

export async function createAccessList(input: AccessListInput, actorUserId: number) {
  const now = nowIso();
  // Validated before anything is written, so a bad rule leaves no half-made list behind.
  const ipRules = input.ipRules === undefined ? [] : sanitizeIpRules(input.ipRules);
  const ipDefault = input.ipDefault === undefined ? "deny" : parseIpDefault(input.ipDefault);
  const satisfy = input.satisfy === undefined ? "all" : parseSatisfy(input.satisfy);

  const [accessList] = await db
    .insert(accessLists)
    .values({
      name: input.name.trim(),
      description: input.description ?? null,
      ipDefault,
      satisfy,
      passAuth: input.passAuth === true,
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
    note: rule.note,
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
  const now = nowIso();
  await runInTransaction((tx) => [
    tx.delete(accessListIpRules).where(eq(accessListIpRules.accessListId, id)),
    ...(sanitized.length > 0
      ? [tx.insert(accessListIpRules).values(ipRuleRows(id, sanitized, now))]
      : []),
    tx.update(accessLists).set({ updatedAt: now }).where(eq(accessLists.id, id)),
  ]);

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

export async function deleteAccessList(id: number, actorUserId: number) {
  const existing = await db.query.accessLists.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
  });
  if (!existing) {
    throw domainError("accessListNotFound");
  }

  await db.delete(accessLists).where(eq(accessLists.id, id));
  await scrubLocationRuleReferences(id);

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
 * Location rules keep their list in the host's meta JSON, which no foreign key can reach. Left in
 * place, a deleted list's id would fail closed there - or, worse, match a list created later.
 */
async function scrubLocationRuleReferences(accessListId: number): Promise<void> {
  const rows = await db.select({ id: proxyHosts.id, meta: proxyHosts.meta }).from(proxyHosts);
  for (const row of rows) {
    if (!row.meta) continue;
    let meta: { location_rules?: { access_list_id?: number | null }[] };
    try {
      meta = JSON.parse(row.meta);
    } catch {
      continue;
    }
    let changed = false;
    for (const rule of meta.location_rules ?? []) {
      if (rule.access_list_id === accessListId) {
        // None rather than inherit: whoever gave the path its own list didn't want the host's.
        rule.access_list_id = null;
        changed = true;
      }
    }
    if (changed) {
      await db
        .update(proxyHosts)
        .set({ meta: JSON.stringify(meta), updatedAt: nowIso() })
        .where(eq(proxyHosts.id, row.id));
    }
  }
}

export type AccessListUsage = {
  id: number;
  name: string;
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
    // The host's own list, and any a location rule on it names: each counts the host once.
    const listIds = new Set<number>();
    if (row.accessListId != null) listIds.add(row.accessListId);
    try {
      const meta = row.meta ? JSON.parse(row.meta) : {};
      for (const rule of meta.location_rules ?? []) {
        if (typeof rule.access_list_id === "number") listIds.add(rule.access_list_id);
      }
    } catch {
      // Unreadable meta names no lists.
    }
    if (listIds.size === 0) continue;
    const usage = {
      id: row.id,
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
  return map;
}
