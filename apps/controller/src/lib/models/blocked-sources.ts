/**
 * The global blocked-sources list. Every write re-applies the config; an expired entry is ignored
 * by the build at once and deleted by the expiry pass within a minute.
 */

import { ipVersion } from "../http/ip-version";
import { asc, count, eq, isNotNull, lte, and } from "drizzle-orm";
import db, { nowIso, toIso } from "../db";
import { blockedSources, users } from "../db/schema";
import { logAuditEvent } from "../audit";
import { diffAuditRecords } from "../audit/changes";
import { domainError } from "../errors/domain-error";
import { normalizeCidr } from "../access-lists/rules";
import {
  type BlockedSource,
  type BlockedSourceKind,
  CONTINENT_CODES,
  MAX_BLOCK_REASON,
  MAX_BLOCKED_SOURCES,
  isBlockedSourceKind,
} from "../blocked-sources/types";
import type { ActiveBlockedSource } from "../caddy/blocked-sources";
import { applyCaddyConfig } from "../caddy";
import { CaddyApplyError } from "../caddy/apply-error";

export type { BlockedSource };

export type BlockedSourceInput = {
  kind: string;
  value: string;
  reason?: string | null;
  /** ISO time; null or absent never expires. */
  expiresAt?: string | null;
};

type Row = typeof blockedSources.$inferSelect;

function toBlockedSource(row: Row, author: string | null): BlockedSource {
  return {
    id: row.id,
    kind: row.kind as BlockedSourceKind,
    value: row.value,
    reason: row.reason,
    expiresAt: toIso(row.expiresAt),
    createdBy: author,
    createdAt: toIso(row.createdAt)!,
  };
}

/** The stored form of a value, or a thrown 400. An address is stored as typed, a range masked. */
export function normalizeBlockedValue(kind: BlockedSourceKind, raw: string): string {
  const value = raw.trim();
  switch (kind) {
    case "ip": {
      const bare = value.replace(/^\[(.*)\]$/, "$1");
      if (!ipVersion(bare)) throw domainError("blockedSourceIpInvalid", {}, { status: 400 });
      return bare.toLowerCase();
    }
    case "cidr": {
      const cidr = value.includes("/") ? normalizeCidr(value) : null;
      if (!cidr) throw domainError("blockedSourceCidrInvalid", {}, { status: 400 });
      // A /0 of either family is every client, the dashboard's own operator included.
      if (cidr.endsWith("/0")) throw domainError("blockedSourceCidrTooWide", {}, { status: 400 });
      return cidr.toLowerCase();
    }
    case "country": {
      const code = value.toUpperCase();
      if (!/^[A-Z]{2}$/.test(code) || code === "XX") {
        throw domainError("blockedSourceCountryInvalid", {}, { status: 400 });
      }
      return code;
    }
    case "continent": {
      const code = value.toUpperCase();
      if (!(CONTINENT_CODES as readonly string[]).includes(code)) {
        throw domainError("blockedSourceContinentInvalid", {}, { status: 400 });
      }
      return code;
    }
    case "asn": {
      const digits = value.replace(/^as/i, "");
      const asn = Number(digits);
      if (!/^\d{1,10}$/.test(digits) || asn <= 0 || asn > 4_294_967_295) {
        throw domainError("blockedSourceAsnInvalid", {}, { status: 400 });
      }
      return String(asn);
    }
  }
}

function normalizeExpiry(raw: string | null | undefined, now: number): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at) || at <= now) {
    throw domainError("blockedSourceExpiryInvalid", {}, { status: 400 });
  }
  return new Date(at).toISOString();
}

function isActive(row: { expiresAt: string | null }, now: number): boolean {
  return row.expiresAt === null || Date.parse(row.expiresAt) > now;
}

export async function listBlockedSources(): Promise<BlockedSource[]> {
  const rows = await db
    .select({ source: blockedSources, author: users.name, email: users.email })
    .from(blockedSources)
    .leftJoin(users, eq(users.id, blockedSources.createdBy))
    .orderBy(asc(blockedSources.kind), asc(blockedSources.value));
  return rows.map(({ source, author, email }) => toBlockedSource(source, author || email || null));
}

/** What the config build denies: unexpired entries only. */
export async function listActiveBlockedSources(now = Date.now()): Promise<ActiveBlockedSource[]> {
  const rows = await db
    .select({
      kind: blockedSources.kind,
      value: blockedSources.value,
      expiresAt: blockedSources.expiresAt,
    })
    .from(blockedSources);
  return rows
    .filter((row) => isActive(row, now) && isBlockedSourceKind(row.kind))
    .map((row) => ({ kind: row.kind as BlockedSourceKind, value: row.value }));
}

/** An unreachable Caddy keeps the change: the monitor applies it once Caddy is back. */
async function apply(): Promise<void> {
  try {
    await applyCaddyConfig();
  } catch (error) {
    if (error instanceof CaddyApplyError && error.code === "CADDY_UNREACHABLE") return;
    throw error;
  }
}

/** A repeat of a listed source updates its reason and expiry rather than failing. */
export async function createBlockedSource(
  input: BlockedSourceInput,
  actorUserId: number,
  now = Date.now(),
): Promise<BlockedSource> {
  if (!isBlockedSourceKind(input.kind)) {
    throw domainError("blockedSourceKindInvalid", {}, { status: 400 });
  }
  const kind = input.kind;
  const value = normalizeBlockedValue(kind, String(input.value ?? ""));
  const reason = (input.reason ?? "").trim();
  if (reason.length > MAX_BLOCK_REASON) {
    throw domainError("wafExclusionReasonTooLong", {}, { status: 400 });
  }
  const expiresAt = normalizeExpiry(input.expiresAt, now);

  const existing = await db.query.blockedSources.findFirst({
    where: (table, { and: both, eq: same }) =>
      both(same(table.kind, kind), same(table.value, value)),
  });
  let record: Row;
  if (existing) {
    [record] = await db
      .update(blockedSources)
      .set({ reason, expiresAt })
      .where(eq(blockedSources.id, existing.id))
      .returning();
  } else {
    const [{ total }] = await db.select({ total: count() }).from(blockedSources);
    if (Number(total) >= MAX_BLOCKED_SOURCES) {
      throw domainError(
        "blockedSourceLimit",
        { max: String(MAX_BLOCKED_SOURCES) },
        { status: 400 },
      );
    }
    [record] = await db
      .insert(blockedSources)
      .values({ kind, value, reason, expiresAt, createdBy: actorUserId, createdAt: nowIso() })
      .returning();
  }

  await logAuditEvent({
    userId: actorUserId,
    action: existing ? "update" : "create",
    entityType: "blocked_source",
    entityId: record.id,
    summary: existing ? `Changed the block on ${kind} ${value}` : `Blocked ${kind} ${value}`,
    data: { kind, value, reason, expiresAt },
    changes: existing
      ? diffAuditRecords(
          { reason: existing.reason, expiresAt: existing.expiresAt },
          { reason, expiresAt },
        )
      : null,
  });
  await apply();
  return toBlockedSource(record, null);
}

export async function deleteBlockedSource(id: number, actorUserId: number): Promise<void> {
  const existing = await db.query.blockedSources.findFirst({
    where: (table, { eq: same }) => same(table.id, id),
  });
  if (!existing) throw domainError("blockedSourceNotFound", {}, { status: 404 });
  await db.delete(blockedSources).where(eq(blockedSources.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "blocked_source",
    entityId: id,
    summary: `Unblocked ${existing.kind} ${existing.value}`,
  });
  await apply();
}

/** Deletes expired entries; re-applies when there were any. Returns how many went. */
export async function pruneExpiredBlockedSources(
  now = Date.now(),
  applyConfig: () => Promise<void> = apply,
): Promise<number> {
  const expired = await db
    .select({ id: blockedSources.id, kind: blockedSources.kind, value: blockedSources.value })
    .from(blockedSources)
    .where(
      and(
        isNotNull(blockedSources.expiresAt),
        lte(blockedSources.expiresAt, new Date(now).toISOString()),
      ),
    );
  if (expired.length === 0) return 0;
  for (const row of expired) {
    await db.delete(blockedSources).where(eq(blockedSources.id, row.id));
    await logAuditEvent({
      userId: null,
      action: "delete",
      entityType: "blocked_source",
      entityId: row.id,
      summary: `The block on ${row.kind} ${row.value} expired`,
    });
  }
  await applyConfig();
  return expired.length;
}
