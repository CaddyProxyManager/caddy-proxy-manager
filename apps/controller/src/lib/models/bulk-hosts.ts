/**
 * One change to many hosts: everything is validated first, written in one transaction, and applied
 * once. Looping the single-host models would apply per host and leave a half-done batch behind the
 * first failure.
 */

import { eq, inArray } from "drizzle-orm";
import db, { nowIso, runInTransaction } from "../db";
import { applyCaddyConfig } from "../caddy";
import { auditEventRow, chainedAuditInsert, type AuditEventParams } from "../audit";
import { accessLists, certificates, l4ProxyHosts, proxyHosts } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { assertCertificatesServable } from "../certificates/placement";
import { assertL4PortPlan } from "../l4/port-plan";
import { agentIdsForHosts } from "./host-agents";
import { normalizeHostTags, withHostTags } from "../proxy-hosts/tags";
import { assertTailscaleServable, assertWildcardIssuable, withMaintenance } from "./proxy-hosts";

/** A page is 25 rows; this only bounds what a REST caller can ask for in one statement. */
export const BULK_HOST_LIMIT = 500;

export const PROXY_HOST_BULK_ACTIONS = [
  "enable",
  "disable",
  "delete",
  "maintenanceOn",
  "maintenanceOff",
  "setCertificate",
  "setAccessList",
  "addTag",
] as const;

export const L4_HOST_BULK_ACTIONS = ["enable", "disable", "delete", "addTag"] as const;

export type ProxyHostBulkAction = (typeof PROXY_HOST_BULK_ACTIONS)[number];
export type L4HostBulkAction = (typeof L4_HOST_BULK_ACTIONS)[number];

export type ProxyHostBulkRequest = {
  action: ProxyHostBulkAction;
  ids: number[];
  /** With `setCertificate`; null is automatic (ACME). */
  certificateId?: number | null;
  /** With `setAccessList`; null removes it. */
  accessListId?: number | null;
  /** With `addTag`, normalised as a host's own tags are. */
  tag?: string;
};

export type L4HostBulkRequest = { action: L4HostBulkAction; ids: number[]; tag?: string };

const invalid = () => domainError("bulkRequestInvalid", {}, { status: 400 });

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Deduplicated; refuses an empty or oversized batch rather than trimming it. */
export function normalizeBulkIds(ids: unknown): number[] {
  if (!Array.isArray(ids) || !ids.every(isPositiveInt)) throw invalid();
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw invalid();
  if (unique.length > BULK_HOST_LIMIT) {
    throw domainError("bulkTooManyHosts", { max: BULK_HOST_LIMIT }, { status: 400 });
  }
  return unique;
}

/** One tag, as it will be stored; blank or several is a malformed request, not a validation error. */
function bulkTag(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  const tags = normalizeHostTags([value]) ?? [];
  if (tags.length !== 1) throw invalid();
  return tags[0];
}

function optionalId(value: unknown): number | null {
  if (value === null) return null;
  if (isPositiveInt(value)) return value;
  throw invalid();
}

/** For REST and GraphQL bodies; the dashboard's actions build the request themselves. */
export function parseProxyHostBulkRequest(body: unknown): ProxyHostBulkRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  const action = input.action as ProxyHostBulkAction;
  if (!PROXY_HOST_BULK_ACTIONS.includes(action)) throw invalid();
  const ids = normalizeBulkIds(input.ids);
  if (action === "setCertificate") {
    if (!("certificateId" in input)) throw invalid();
    return { action, ids, certificateId: optionalId(input.certificateId) };
  }
  if (action === "setAccessList") {
    if (!("accessListId" in input)) throw invalid();
    return { action, ids, accessListId: optionalId(input.accessListId) };
  }
  if (action === "addTag") return { action, ids, tag: bulkTag(input.tag) };
  return { action, ids };
}

export function parseL4HostBulkRequest(body: unknown): L4HostBulkRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  const action = input.action as L4HostBulkAction;
  if (!L4_HOST_BULK_ACTIONS.includes(action)) throw invalid();
  const ids = normalizeBulkIds(input.ids);
  if (action === "addTag") return { action, ids, tag: bulkTag(input.tag) };
  return { action, ids };
}

/** English, parsed back by `lib/audit/summary.ts` into the reader's language like a single edit. */
function proxyHostSummary(action: ProxyHostBulkAction, name: string): string {
  if (action === "delete") return `Deleted proxy host ${name}`;
  if (action === "maintenanceOn") return `Turned on maintenance mode for proxy host ${name}`;
  if (action === "maintenanceOff") return `Turned off maintenance mode for proxy host ${name}`;
  return `Updated proxy host ${name}`;
}

function proxyHostAuditData(request: ProxyHostBulkRequest): Record<string, unknown> {
  switch (request.action) {
    case "enable":
      return { enabled: true, bulk: true };
    case "disable":
      return { enabled: false, bulk: true };
    case "maintenanceOn":
      return { maintenance: { enabled: true }, bulk: true };
    case "maintenanceOff":
      return { maintenance: { enabled: false }, bulk: true };
    case "setCertificate":
      return { certificateId: request.certificateId ?? null, bulk: true };
    case "setAccessList":
      return { accessListId: request.accessListId ?? null, bulk: true };
    case "addTag":
      return { addedTag: request.tag, bulk: true };
    default:
      return { bulk: true };
  }
}

/**
 * All or nothing: an id that does not exist, or a target the hosts could not be served with,
 * refuses the whole batch before anything is written. Permission checks are the caller's.
 */
export async function bulkUpdateProxyHosts(
  request: ProxyHostBulkRequest,
  actorUserId: number,
): Promise<{ count: number }> {
  const ids = normalizeBulkIds(request.ids);
  const rows = await db
    .select({
      id: proxyHosts.id,
      name: proxyHosts.name,
      domains: proxyHosts.domains,
      certificateId: proxyHosts.certificateId,
      meta: proxyHosts.meta,
      tags: proxyHosts.tags,
    })
    .from(proxyHosts)
    .where(inArray(proxyHosts.id, ids));
  if (rows.length !== ids.length) {
    throw domainError("proxyHostNotFound", {}, { status: 404 });
  }
  // Before anything is written: one host already at the limit refuses the batch.
  const taggedTo =
    request.action === "addTag"
      ? new Map(rows.map((row) => [row.id, withHostTags(row.tags, [bulkTag(request.tag)])]))
      : null;

  if (request.action === "setCertificate" && request.certificateId != null) {
    const [certificate] = await db
      .select({ id: certificates.id })
      .from(certificates)
      .where(eq(certificates.id, request.certificateId));
    if (!certificate) throw domainError("certificateNotFound", {}, { status: 400 });
  }
  if (request.action === "setAccessList" && request.accessListId != null) {
    const [list] = await db
      .select({ id: accessLists.id })
      .from(accessLists)
      .where(eq(accessLists.id, request.accessListId));
    if (!list) throw domainError("accessListNotFound", {}, { status: 400 });
  }
  // The same checks a single save runs for the state the host ends up in.
  if (request.action === "setCertificate" && request.certificateId != null) {
    const pins = await agentIdsForHosts("http", ids);
    await assertCertificatesServable(
      rows.map((row) => ({
        certificateId: request.certificateId ?? null,
        agentIds: pins.get(row.id) ?? [],
      })),
    );
  }
  for (const row of rows) {
    const domains = JSON.parse(row.domains) as string[];
    if (request.action === "setCertificate") {
      await assertWildcardIssuable(domains, request.certificateId ?? null);
    }
    if (request.action === "enable") {
      await assertWildcardIssuable(domains, row.certificateId ?? null);
      await assertTailscaleServable(row.meta ?? null);
    }
  }

  const now = nowIso();
  const where = inArray(proxyHosts.id, ids);
  const audits: AuditEventParams[] = rows.map((row) => ({
    userId: actorUserId,
    action: request.action === "delete" ? "delete" : "update",
    entityType: "proxy_host",
    entityId: row.id,
    summary: proxyHostSummary(request.action, row.name),
    data: proxyHostAuditData(request),
  }));

  await runInTransaction((tx) => {
    const writes = (() => {
      switch (request.action) {
        case "enable":
        case "disable":
          return [
            tx
              .update(proxyHosts)
              .set({ enabled: request.action === "enable", updatedAt: now })
              .where(where),
          ];
        case "setCertificate":
          return [
            tx
              .update(proxyHosts)
              .set({ certificateId: request.certificateId ?? null, updatedAt: now })
              .where(where),
          ];
        case "setAccessList":
          return [
            tx
              .update(proxyHosts)
              .set({ accessListId: request.accessListId ?? null, updatedAt: now })
              .where(where),
          ];
        // Grants, agent pins and forward-auth sessions go with the row by foreign-key cascade,
        // exactly as a single delete does.
        case "delete":
          return [tx.delete(proxyHosts).where(where)];
        // Tags and meta differ per host, so one statement each - still inside the one transaction.
        case "addTag":
          return rows.map((row) =>
            tx
              .update(proxyHosts)
              .set({ tags: taggedTo?.get(row.id), updatedAt: now })
              .where(eq(proxyHosts.id, row.id)),
          );
        case "maintenanceOn":
        case "maintenanceOff":
          return rows.map((row) =>
            tx
              .update(proxyHosts)
              .set({
                meta: withMaintenance(row.meta ?? null, request.action === "maintenanceOn"),
                updatedAt: now,
              })
              .where(eq(proxyHosts.id, row.id)),
          );
      }
    })();
    return [...writes, chainedAuditInsert(tx, audits.map(auditEventRow))];
  });

  // Tags never reach the config, so there is nothing to reload.
  if (request.action !== "addTag") await applyCaddyConfig();
  return { count: rows.length };
}

export async function bulkUpdateL4ProxyHosts(
  request: L4HostBulkRequest,
  actorUserId: number,
): Promise<{ count: number }> {
  const ids = normalizeBulkIds(request.ids);
  const rows = await db
    .select({
      id: l4ProxyHosts.id,
      name: l4ProxyHosts.name,
      protocol: l4ProxyHosts.protocol,
      listenAddress: l4ProxyHosts.listenAddress,
      enabled: l4ProxyHosts.enabled,
      tags: l4ProxyHosts.tags,
    })
    .from(l4ProxyHosts)
    .where(inArray(l4ProxyHosts.id, ids));
  if (rows.length !== ids.length) {
    throw domainError("l4ProxyHostNotFound", {}, { status: 404 });
  }
  if (request.action === "enable") {
    // As the single-host save does, and against each other: two in one batch can clash too.
    const enabling = rows.filter((row) => !row.enabled);
    const assignments = await agentIdsForHosts(
      "l4",
      enabling.map((row) => row.id),
    );
    await assertL4PortPlan(
      enabling.map((row) => ({ ...row, agentIds: assignments.get(row.id) ?? [] })),
    );
  }

  const taggedTo =
    request.action === "addTag"
      ? new Map(rows.map((row) => [row.id, withHostTags(row.tags, [bulkTag(request.tag)])]))
      : null;

  const where = inArray(l4ProxyHosts.id, ids);
  const audits = rows.map((row) =>
    auditEventRow({
      userId: actorUserId,
      action: request.action === "delete" ? "delete" : "update",
      entityType: "l4_proxy_host",
      entityId: row.id,
      summary:
        request.action === "delete"
          ? `Deleted L4 proxy host ${row.name}`
          : `Updated L4 proxy host ${row.name}`,
      data:
        request.action === "delete"
          ? { bulk: true }
          : request.action === "addTag"
            ? { addedTag: request.tag, bulk: true }
            : { enabled: request.action === "enable", bulk: true },
    }),
  );

  const now = nowIso();
  await runInTransaction((tx) => [
    ...(request.action === "delete"
      ? [tx.delete(l4ProxyHosts).where(where)]
      : request.action === "addTag"
        ? rows.map((row) =>
            tx
              .update(l4ProxyHosts)
              .set({ tags: taggedTo?.get(row.id), updatedAt: now })
              .where(eq(l4ProxyHosts.id, row.id)),
          )
        : [
            tx
              .update(l4ProxyHosts)
              .set({ enabled: request.action === "enable", updatedAt: now })
              .where(where),
          ]),
    chainedAuditInsert(tx, audits),
  ]);

  // Published ports are derived from the enabled hosts: the ports banner picks this up unaided.
  if (request.action !== "addTag") await applyCaddyConfig();
  return { count: rows.length };
}
