/**
 * Reading, comparing and going back to host revisions. History only grows: a rollback or restore
 * is a new revision, never an edit of an old one. Snapshots keep secrets as stored, and nothing
 * here decrypts one; what leaves for a browser is the masked field diff or the parsed host the
 * host's own query already answers.
 */

import { and, asc, count, desc, eq, inArray, like, lt, max } from "drizzle-orm";
import { auditEventRow } from "../audit";
import type { AuditChange } from "../audit/changes";
import { chainedAuditSteps } from "../audit/chain";
import { applyCaddyConfig } from "../caddy";
import db, { nowIso } from "../db";
import { hostRevisions, proxyHosts, users } from "../db/schema";
import { parseHostUuid } from "../hosts/ref";
import { domainError } from "../errors/domain-error";
import { hostAuditChanges } from "../host-review/audit";
import { assertL4PortPlan } from "../l4/port-plan";
import { type L4ProxyHost, blankL4ProxyHost, l4ProxyHostFromRow } from "../models/l4-proxy-hosts";
import { type ProxyHost, blankProxyHost, proxyHostFromRow } from "../models/proxy-hosts";
import { type ConfigDiff, diffConfigDocuments } from "../settings/config-diff";
import { missingReferenceDetails, missingReferences, withoutMissing } from "./references";
import {
  HOST_TABLES,
  type HostSnapshot,
  recordHostRevision,
  runHostWrite,
  setHostAgentsSteps,
  withRevisionId,
} from "./record";
import { pruneHostRevisions } from "./retention";
import {
  HOST_REVISION_OPERATIONS,
  type HostKind,
  type HostRevisionDetail,
  type HostRevisionOperation,
  type HostRevisionSummary,
  type MissingReference,
  type AuditRevisionLink,
} from "./types";

export type HostRevision = HostRevisionSummary & { snapshot: HostSnapshot };

type RevisionRow = typeof hostRevisions.$inferSelect;

const ENTITY = { http: "proxy_host", l4: "l4_proxy_host" } as const;
const NOUN = { http: "proxy host", l4: "L4 proxy host" } as const;

function parseDetail(raw: string | null): HostRevisionDetail | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as HostRevisionDetail) : null;
  } catch {
    return null;
  }
}

export function parseSnapshot(raw: string): HostSnapshot {
  const parsed = JSON.parse(raw) as Partial<HostSnapshot>;
  return {
    row: parsed.row ?? {},
    agentIds: Array.isArray(parsed.agentIds) ? parsed.agentIds.filter(Number.isInteger) : [],
  };
}

function toRevision(row: RevisionRow): HostRevision {
  const snapshot = parseSnapshot(row.snapshot);
  const operation = (HOST_REVISION_OPERATIONS as readonly string[]).includes(row.operation)
    ? (row.operation as HostRevisionOperation)
    : "update";
  return {
    id: row.id,
    hostKind: row.hostKind === "l4" ? "l4" : "http",
    hostId: row.hostId,
    operation,
    detail: parseDetail(row.detail),
    userId: row.userId ?? null,
    userName: row.userName ?? null,
    createdAt: row.createdAt,
    name: typeof snapshot.row.name === "string" ? snapshot.row.name : "",
    snapshot,
  };
}

/** The snapshot left out: it carries the stored row, secrets and all. */
export function summarizeRevision({ snapshot: _snapshot, ...summary }: HostRevision) {
  return summary satisfies HostRevisionSummary;
}

const ofHost = (kind: HostKind, hostId: number) =>
  and(eq(hostRevisions.hostKind, kind), eq(hostRevisions.hostId, hostId));

export async function listHostRevisions(
  kind: HostKind,
  hostId: number,
  limit = 20,
  offset = 0,
): Promise<HostRevisionSummary[]> {
  const rows = await db
    .select()
    .from(hostRevisions)
    .where(ofHost(kind, hostId))
    .orderBy(desc(hostRevisions.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => summarizeRevision(toRevision(row)));
}

export async function countHostRevisions(kind: HostKind, hostId: number): Promise<number> {
  const [row] = await db.select({ total: count() }).from(hostRevisions).where(ofHost(kind, hostId));
  return Number(row?.total ?? 0);
}

/** Capped: nobody scrolls a picker further. */
export async function hostRevisionIds(kind: HostKind, hostId: number, limit = 500) {
  const rows = await db
    .select({ id: hostRevisions.id })
    .from(hostRevisions)
    .where(ofHost(kind, hostId))
    .orderBy(desc(hostRevisions.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export async function getHostRevision(id: number): Promise<HostRevision | null> {
  const [row] = await db.select().from(hostRevisions).where(eq(hostRevisions.id, id));
  return row ? toRevision(row) : null;
}

/** The host's revision before `id`; 0 before its first. */
export async function previousHostRevisionId(
  kind: HostKind,
  hostId: number,
  id: number,
): Promise<number> {
  const [row] = await db
    .select({ id: max(hostRevisions.id) })
    .from(hostRevisions)
    .where(and(ofHost(kind, hostId), lt(hostRevisions.id, id)));
  return Number(row?.id ?? 0);
}

export async function hostExists(kind: HostKind, hostId: number): Promise<boolean> {
  const { table } = HOST_TABLES[kind];
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, hostId));
  return Boolean(row);
}

export function hostFromSnapshot(kind: "http", snapshot: HostSnapshot): ProxyHost;
export function hostFromSnapshot(kind: "l4", snapshot: HostSnapshot): L4ProxyHost;
export function hostFromSnapshot(kind: HostKind, snapshot: HostSnapshot): ProxyHost | L4ProxyHost;
export function hostFromSnapshot(kind: HostKind, snapshot: HostSnapshot) {
  return kind === "http" ? proxyHostFromRow(snapshot.row) : l4ProxyHostFromRow(snapshot.row);
}

/** A deleted state reads as no host: its snapshot is what was there before, kept for a restore. */
function side(revision: HostRevision | null) {
  if (!revision || revision.operation === "delete") return null;
  return {
    host: hostFromSnapshot(revision.hostKind, revision.snapshot) as Record<string, unknown>,
    agentIds: revision.snapshot.agentIds,
  };
}

export type HostRevisionComparison = {
  from: number;
  to: number;
  changes: AuditChange[];
  /** Undefined when not asked for; null when it could not be rendered. */
  config?: ConfigDiff | null;
};

async function renderWith(kind: HostKind, hostId: number, revision: HostRevision | null) {
  const row = revision && revision.operation !== "delete" ? revision.snapshot.row : null;
  // Late, as only a comparison asking for the config needs the builder.
  const { buildCaddyDocument } = await import("../caddy");
  return buildCaddyDocument(undefined, {
    includeAgentFileCertificates: true,
    hostOverride: { kind, id: hostId, row },
  });
}

/**
 * Either direction; `from` may be 0, before the host existed. The config diff renders the whole
 * document twice with only this host swapped, so it shows what the host contributes and nothing
 * the rest of the fleet did since.
 */
export async function compareHostRevisions(
  kind: HostKind,
  hostId: number,
  from: number,
  to: number,
  options: { config?: boolean } = {},
): Promise<HostRevisionComparison | null> {
  const [left, right] = await Promise.all([
    from === 0 ? null : getHostRevision(from),
    getHostRevision(to),
  ]);
  const belongs = (revision: HostRevision | null) =>
    revision !== null && revision.hostKind === kind && revision.hostId === hostId;
  if (!belongs(right) || (from !== 0 && !belongs(left))) return null;

  const blank = (kind === "http" ? blankProxyHost() : blankL4ProxyHost()) as Record<
    string,
    unknown
  >;
  const before = side(left);
  const after = side(right);
  const changes =
    before === null && after === null ? [] : await hostAuditChanges(kind, before, after, blank);

  const comparison: HostRevisionComparison = { from, to, changes };
  if (options.config) {
    try {
      const [a, b] = await Promise.all([
        renderWith(kind, hostId, left),
        renderWith(kind, hostId, right),
      ]);
      comparison.config = diffConfigDocuments(a, b);
    } catch (error) {
      // As in settings history: a builder that throws costs the config pane, not the page.
      console.error("Failed to render the host revision config diff:", error);
      comparison.config = null;
    }
  }
  return comparison;
}

/** A revision to load into the editor: missing references taken out and listed. */
export async function revisionForEditor(
  kind: HostKind,
  hostId: number,
  revisionId: number,
): Promise<{ snapshot: HostSnapshot; missing: MissingReference[] } | null> {
  const revision = await getHostRevision(revisionId);
  if (!revision || revision.hostKind !== kind || revision.hostId !== hostId) return null;
  const missing = await missingReferences(kind, revision.snapshot);
  return { snapshot: withoutMissing(revision.snapshot, missing), missing };
}

function refuseMissing(missing: MissingReference[]): void {
  if (missing.length === 0) return;
  throw domainError(
    "hostReferencesMissing",
    { references: missingReferenceDetails(missing) },
    { status: 409 },
  );
}

async function assertNoDomainClash(snapshot: HostSnapshot, hostId: number): Promise<void> {
  let domains: string[] = [];
  try {
    domains = JSON.parse(String(snapshot.row.domains ?? "[]"));
  } catch {
    domains = [];
  }
  const wanted = new Set(domains.map((domain) => domain.toLowerCase()));
  if (wanted.size === 0) return;
  const others = await db
    .select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains })
    .from(proxyHosts);
  for (const other of others) {
    if (other.id === hostId) continue;
    let theirs: string[] = [];
    try {
      theirs = JSON.parse(other.domains);
    } catch {
      continue;
    }
    const clash = theirs.find((domain) => wanted.has(domain.toLowerCase()));
    if (clash) {
      throw domainError(
        "hostRestoreDomainConflict",
        { domain: clash, host: other.name },
        { status: 409 },
      );
    }
  }
}

async function assertListenerFree(snapshot: HostSnapshot, hostId: number): Promise<void> {
  if (!snapshot.row.enabled) return;
  await assertL4PortPlan([
    {
      id: hostId,
      protocol: String(snapshot.row.protocol) as "tcp" | "udp",
      listenAddress: String(snapshot.row.listenAddress),
      agentIds: snapshot.agentIds,
    },
  ]);
}

/** Columns a revision puts back: everything but the identity and who first made the host. */
function restorableColumns(row: Record<string, unknown>) {
  const { id: _id, ownerUserId: _owner, createdAt: _created, updatedAt: _updated, ...rest } = row;
  return rest;
}

async function existingUser(id: unknown): Promise<number | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id as number));
  return row ? row.id : null;
}

export async function auditChangesFor(
  kind: HostKind,
  before: { host: Record<string, unknown>; agentIds: number[] } | null,
  snapshot: HostSnapshot,
) {
  const blank = (kind === "http" ? blankProxyHost() : blankL4ProxyHost()) as Record<
    string,
    unknown
  >;
  return hostAuditChanges(
    kind,
    before,
    {
      host: hostFromSnapshot(kind, snapshot) as Record<string, unknown>,
      agentIds: snapshot.agentIds,
    },
    blank,
  );
}

/**
 * A deleted host back from one of its revisions, under its old id so its history continues. A
 * domain (or, at layer 4, a listener) now taken elsewhere is a conflict. Missing references are
 * refused unless the caller chose to drop them.
 */
/**
 * The serial id a deleted host had, found by the uuid its last snapshot carries. A live host is
 * resolved by its row instead; hosts deleted before uuids existed cannot be found this way.
 */
export async function deletedHostIdForUuid(kind: HostKind, raw: string): Promise<number | null> {
  const uuid = parseHostUuid(raw);
  if (!uuid) return null;
  const [row] = await db
    .select({ hostId: hostRevisions.hostId })
    .from(hostRevisions)
    .where(
      and(eq(hostRevisions.hostKind, kind), like(hostRevisions.snapshot, `%"uuid":"${uuid}"%`)),
    )
    .limit(1);
  return row?.hostId ?? null;
}

export async function restoreHost(
  revisionId: number,
  actorUserId: number,
  options: { dropMissingReferences?: boolean; kind?: HostKind } = {},
): Promise<{ kind: HostKind; hostId: number; revisionId: number }> {
  const revision = await getHostRevision(revisionId);
  if (!revision || (options.kind && revision.hostKind !== options.kind))
    throw domainError("hostRevisionNotFound", { revision: revisionId }, { status: 404 });
  const { hostKind: kind, hostId } = revision;
  if (await hostExists(kind, hostId)) {
    throw domainError("hostRestoreExists", {}, { status: 409 });
  }
  const missing = await missingReferences(kind, revision.snapshot);
  if (!options.dropMissingReferences) refuseMissing(missing);
  const snapshot = withoutMissing(revision.snapshot, missing);
  if (kind === "http") await assertNoDomainClash(snapshot, hostId);
  else await assertListenerFree(snapshot, hostId);

  const owner = await existingUser(snapshot.row.ownerUserId);
  const changes = await auditChangesFor(kind, null, snapshot);
  const { table } = HOST_TABLES[kind];
  const now = nowIso();
  const created = await runHostWrite(function* (tx) {
    yield {
      run: tx.insert(table).values({
        ...restorableColumns(snapshot.row),
        id: hostId,
        ownerUserId: owner,
        createdAt: typeof snapshot.row.createdAt === "string" ? snapshot.row.createdAt : now,
        updatedAt: now,
      }),
    };
    yield* setHostAgentsSteps(tx, kind, hostId, snapshot.agentIds);
    const id = yield* recordHostRevision(tx, {
      kind,
      hostId,
      operation: "restore",
      detail: { revision: revisionId },
      userId: actorUserId,
    });
    const audit = withRevisionId(
      {
        userId: actorUserId,
        action: "restore",
        entityType: ENTITY[kind],
        entityId: hostId,
        summary: `Restored ${NOUN[kind]} ${String(snapshot.row.name ?? "")}`,
        changes,
      },
      id,
    );
    yield* chainedAuditSteps(tx, [auditEventRow(audit)]);
    return id;
  });
  await pruneHostRevisions(kind, [hostId]);
  await applyCaddyConfig();
  return { kind, hostId, revisionId: created };
}

/**
 * A live host put back as a revision stored it, for the API; the dashboard goes through the
 * editor and its review instead. Refuses a revision naming anything since deleted.
 */
export async function rollbackHost(
  revisionId: number,
  actorUserId: number,
): Promise<{ kind: HostKind; hostId: number; revisionId: number }> {
  const revision = await getHostRevision(revisionId);
  if (!revision)
    throw domainError("hostRevisionNotFound", { revision: revisionId }, { status: 404 });
  const { hostKind: kind, hostId, snapshot } = revision;
  if (revision.operation === "delete") {
    throw domainError("hostRollbackDeleted", {}, { status: 409 });
  }
  const { table, agents, hostColumn } = HOST_TABLES[kind];
  const [current] = await db.select().from(table).where(eq(table.id, hostId));
  if (!current) throw domainError("hostRollbackGone", {}, { status: 409 });
  refuseMissing(await missingReferences(kind, snapshot));
  if (kind === "l4") await assertListenerFree(snapshot, hostId);

  const pins = await db
    .select({ agentId: agents.agentId })
    .from(agents)
    .where(eq(hostColumn, hostId))
    .orderBy(asc(agents.agentId));
  const changes = await auditChangesFor(
    kind,
    {
      host: hostFromSnapshot(kind, { row: current, agentIds: [] }) as Record<string, unknown>,
      agentIds: pins.map((pin) => pin.agentId),
    },
    snapshot,
  );
  const now = nowIso();
  const created = await runHostWrite(function* (tx) {
    yield {
      run: tx
        .update(table)
        .set({ ...restorableColumns(snapshot.row), updatedAt: now })
        .where(eq(table.id, hostId)),
    };
    yield* setHostAgentsSteps(tx, kind, hostId, snapshot.agentIds);
    const id = yield* recordHostRevision(tx, {
      kind,
      hostId,
      operation: "rollback",
      detail: { revision: revisionId },
      userId: actorUserId,
    });
    const audit = withRevisionId(
      {
        userId: actorUserId,
        action: "update",
        entityType: ENTITY[kind],
        entityId: hostId,
        summary: `Rolled back ${NOUN[kind]} ${String(snapshot.row.name ?? current.name)} to revision ${revisionId}`,
        changes,
      },
      id,
    );
    yield* chainedAuditSteps(tx, [auditEventRow(audit)]);
    return id;
  });
  await pruneHostRevisions(kind, [hostId]);
  await applyCaddyConfig();
  return { kind, hostId, revisionId: created };
}

export type DeletedHost = { hostId: number; name: string; revisionId: number; deletedAt: string };

/** Hosts whose last revision is their deletion, newest first. */
export async function listDeletedHosts(kind: HostKind, limit = 100): Promise<DeletedHost[]> {
  const latest = db
    .select({ id: max(hostRevisions.id).as("id") })
    .from(hostRevisions)
    .where(eq(hostRevisions.hostKind, kind))
    .groupBy(hostRevisions.hostId);
  const lastIds = (await latest).map((row) => Number(row.id));
  if (lastIds.length === 0) return [];
  const rows = await db
    .select()
    .from(hostRevisions)
    .where(and(inArray(hostRevisions.id, lastIds), eq(hostRevisions.operation, "delete")))
    .orderBy(desc(hostRevisions.id))
    .limit(limit);
  const { table } = HOST_TABLES[kind];
  const live = new Set(
    rows.length === 0
      ? []
      : (
          await db
            .select({ id: table.id })
            .from(table)
            .where(
              inArray(
                table.id,
                rows.map((row) => row.hostId),
              ),
            )
        ).map((row) => row.id),
  );
  return rows
    .filter((row) => !live.has(row.hostId))
    .map((row) => {
      const revision = toRevision(row);
      return {
        hostId: row.hostId,
        name: revision.name,
        revisionId: row.id,
        deletedAt: row.createdAt,
      };
    });
}

export { missingReferences, withoutMissing } from "./references";

/** The revision an editor save rolls back to, from its form; refuses another host's. */
export async function rollbackRevisionFrom(
  formData: FormData,
  kind: HostKind,
  hostId: number,
): Promise<number | undefined> {
  const raw = formData.get("rollbackRevision");
  if (typeof raw !== "string" || raw === "") return undefined;
  const revision = /^\d{1,9}$/.test(raw) ? await getHostRevision(Number(raw)) : null;
  if (!revision || revision.hostKind !== kind || revision.hostId !== hostId) {
    throw domainError("rollbackRevisionInvalid", {}, { status: 400 });
  }
  return revision.id;
}

async function hostUuidFor(
  kind: HostKind,
  hostId: number,
  snapshotRow: Record<string, unknown>,
): Promise<string | null> {
  if (typeof snapshotRow.uuid === "string" && snapshotRow.uuid) return snapshotRow.uuid;
  const { table } = HOST_TABLES[kind];
  const [row] = await db.select({ uuid: table.uuid }).from(table).where(eq(table.id, hostId));
  return row?.uuid ?? null;
}

/**
 * Where a host event's revision is gone back from: the history comparing it with the revision
 * before, ready to roll back to that one; for a deletion, the history ready to restore.
 */
export async function auditRevisionLinks(
  events: { id: number; entityType: string; entityId: number | null; revisionId: number | null }[],
): Promise<Map<number, AuditRevisionLink>> {
  const links = new Map<number, AuditRevisionLink>();
  const paths = { http: "/proxy-hosts", l4: "/l4-proxy-hosts" } as const;
  for (const event of events) {
    if (event.revisionId === null || event.entityId === null) continue;
    const kind =
      event.entityType === "proxy_host"
        ? "http"
        : event.entityType === "l4_proxy_host"
          ? "l4"
          : null;
    if (!kind) continue;
    const revision = await getHostRevision(event.revisionId);
    if (!revision || revision.hostKind !== kind || revision.hostId !== event.entityId) continue;
    // By uuid, as every host URL is: from the snapshot, else the live row. A host deleted before
    // uuids existed has neither, and no address that would resolve.
    const uuid = await hostUuidFor(kind, event.entityId, revision.snapshot.row);
    if (!uuid) continue;
    const base = `${paths[kind]}/${uuid}/history`;
    if (revision.operation === "delete") {
      links.set(event.id, { kind: "restore", href: `${base}?to=${revision.id}` });
      continue;
    }
    const before = await previousHostRevisionId(kind, event.entityId, revision.id);
    if (before === 0) continue;
    links.set(event.id, { kind: "rollback", href: `${base}?from=${revision.id}&to=${before}` });
  }
  return links;
}
