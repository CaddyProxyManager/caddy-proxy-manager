/**
 * IdP group names mapped to a CPM group, taking precedence over the provider's `groupPrefix`
 * convention for names an operator wants shown differently. The normalised name (lower-cased,
 * Keycloak path stripped) is stored beside the spelling, so a lookup is an indexed equality.
 */

import { eq, isNull, or } from "drizzle-orm";
import db, { nowIso } from "../db";
import { groupIdpMappings, groups } from "../db/schema";
import { normalizeGroupName } from "../auth/oidc/groups";

export type GroupIdpMapping = {
  id: number;
  groupId: number;
  /** The provider this applies to, or null for "any provider". */
  providerId: string | null;
  externalName: string;
};

function comparableKey(value: string): string {
  return normalizeGroupName(value).toLowerCase();
}

function toMapping(row: typeof groupIdpMappings.$inferSelect): GroupIdpMapping {
  return {
    id: row.id,
    groupId: row.groupId,
    providerId: row.providerId,
    externalName: row.externalName,
  };
}

export async function listMappingsForGroup(groupId: number): Promise<GroupIdpMapping[]> {
  const rows = await db
    .select()
    .from(groupIdpMappings)
    .where(eq(groupIdpMappings.groupId, groupId))
    .orderBy(groupIdpMappings.externalName);
  return rows.map(toMapping);
}

/** Every mapping, keyed by group id - for the page that lists all the groups at once. */
export async function listAllMappings(): Promise<Map<number, GroupIdpMapping[]>> {
  const rows = await db.select().from(groupIdpMappings).orderBy(groupIdpMappings.externalName);
  const byGroup = new Map<number, GroupIdpMapping[]>();
  for (const row of rows) {
    const bucket = byGroup.get(row.groupId) ?? [];
    bucket.push(toMapping(row));
    byGroup.set(row.groupId, bucket);
  }
  return byGroup;
}

/**
 * Deduplicated here, not by a unique index: `providerId` is nullable and PostgreSQL treats NULLs as
 * distinct. This module is the only writer.
 */
export async function setGroupMappings(
  groupId: number,
  entries: { providerId: string | null; externalName: string }[],
): Promise<void> {
  const seen = new Set<string>();
  const rows: { providerId: string | null; externalName: string; externalKey: string }[] = [];
  for (const entry of entries) {
    const externalName = entry.externalName.trim();
    if (!externalName) continue;
    const externalKey = comparableKey(externalName);
    if (!externalKey) continue;
    const providerId = entry.providerId?.trim() || null;
    const dedupe = `${providerId ?? "*"}\u0000${externalKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({ providerId, externalName, externalKey });
  }

  await db.delete(groupIdpMappings).where(eq(groupIdpMappings.groupId, groupId));
  if (rows.length === 0) return;

  const now = nowIso();
  await db
    .insert(groupIdpMappings)
    .values(rows.map((row) => ({ ...row, groupId, createdAt: now })));
}

/** A mapping with no provider matches any, so a single-IdP deployment need not name it per row. */
export async function mappedGroupNames(claimed: string[], providerId: string): Promise<string[]> {
  if (claimed.length === 0) return [];
  const keys = new Set(claimed.map(comparableKey).filter(Boolean));
  if (keys.size === 0) return [];

  const rows = await db
    .select({ name: groups.name, externalKey: groupIdpMappings.externalKey })
    .from(groupIdpMappings)
    .innerJoin(groups, eq(groups.id, groupIdpMappings.groupId))
    .where(or(eq(groupIdpMappings.providerId, providerId), isNull(groupIdpMappings.providerId)));

  const matched: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!keys.has(row.externalKey)) continue;
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(row.name);
  }
  return matched;
}

/**
 * Keeps mapped names from the prefix convention, or a claim already mapped by name would also be
 * mirrored under its raw IdP name and put the user in two groups.
 */
export async function mappedExternalKeys(providerId: string): Promise<Set<string>> {
  const rows = await db
    .select({ externalKey: groupIdpMappings.externalKey })
    .from(groupIdpMappings)
    .where(or(eq(groupIdpMappings.providerId, providerId), isNull(groupIdpMappings.providerId)));
  return new Set(rows.map((row) => row.externalKey));
}
