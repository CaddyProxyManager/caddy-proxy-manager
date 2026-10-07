/**
 * Every write a policy can hold back, as data: what it touches, what its approvers see, how to tell
 * the target moved since, and the model call that applies it. The entry points route through
 * these too, so a direct write and an approved one run the same code.
 */

import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { logAuditEvent } from "../audit";
import { type AuditChange, diffAuditRecords } from "../audit/changes";
import db from "../db";
import { crsPlugins, wafExclusions } from "../db/schema";
import { domainError } from "../errors/domain-error";
import type { HostKind } from "../host-review/types";
import type { AccessList, AccessListInput, AccessListSettingsInput } from "../models/access-lists";
import type { L4HostBulkRequest, ProxyHostBulkRequest } from "../models/bulk-hosts";
import type { L4ProxyHostInput } from "../models/l4-proxy-hosts";
import type { MtlsAccessRuleInput } from "../models/mtls-access-rules";
import type { ProxyHostInput } from "../models/proxy-hosts";
import type { WafExclusionInput } from "../models/waf-exclusions";
import type { WafPresetInput } from "../models/waf-presets";
import type { ForwardAuthAccessInput } from "../proxy-hosts/form";
import { parseStoredTags } from "../proxy-hosts/tags";
import type { Capability, ObjectKind } from "../roles/capabilities";
import type { SettingsEntry } from "../settings/apply";
import { diffConfigDocuments } from "../settings/config-diff";
import { withStagedReads } from "../settings/staging-context";
import {
  type ApprovalArea,
  type ApprovalPolicy,
  APPROVAL_POLICY_KEY,
  approvalPolicyProblem,
  readApprovalPolicy,
} from "./policy";
import type { ChangeKind, ChangePreview } from "./types";

/**
 * Loaded when a change runs, not with this module: every host, list and WAF write route imports
 * it, and a test standing in for one model must not have to stand in for all of them.
 */
const load = {
  caddy: () => import("../caddy"),
  hostHistory: () => import("../host-history"),
  record: () => import("../host-history/record"),
  hostReview: () => import("../host-review"),
  accessLists: () => import("../models/access-lists"),
  bulk: () => import("../models/bulk-hosts"),
  crs: () => import("../models/crs-plugins"),
  forwardAuth: () => import("../models/forward-auth"),
  l4: () => import("../models/l4-proxy-hosts"),
  mtls: () => import("../models/mtls-access-rules"),
  proxyHosts: () => import("../models/proxy-hosts"),
  wafExclusions: () => import("../models/waf-exclusions"),
  wafPresets: () => import("../models/waf-presets"),
  settingsApply: () => import("../settings/apply"),
  settingsApi: () => import("../settings/api"),
  staging: () => import("../settings/staging"),
  settings: () => import("../settings"),
};

export type Actor = { userId: number; name: string | null };

export type Need = { capability: Capability; object?: { kind: ObjectKind; id: number } };

export type Target = { type: string; id: number | null; name: string | null };

type KindDefinition<P, R> = {
  area: ApprovalArea;
  /** What the requester must still hold when an approval applies it. */
  needs: (payload: P) => Need[];
  target: (payload: P) => Promise<Target>;
  /** Host tags before or after, which a tag policy matches on. Not a host change: none. */
  tags?: (payload: P) => Promise<string[]>;
  /** The target as stored; hashed at submission, and a different hash at apply invalidates. */
  state: (payload: P) => Promise<unknown>;
  /** Runs the checks a save would, so an invalid change is refused rather than queued. */
  preview: (payload: P, requester: Actor) => Promise<ChangePreview>;
  apply: (payload: P, actor: Actor) => Promise<R>;
};

const define = <P, R>(definition: KindDefinition<P, R>) => definition;

export function stateHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

// ── Hosts ────────────────────────────────────────────────────────────

const OBJECT: Record<HostKind, ObjectKind> = { http: "proxyHost", l4: "l4ProxyHost" };

async function hostRow(kind: HostKind, id: number) {
  const { table, agents, hostColumn } = (await load.record()).HOST_TABLES[kind];
  const [row] = (await db.select().from(table).where(eq(table.id, id))) as Record<
    string,
    unknown
  >[];
  if (!row) return null;
  const pins = (await db
    .select({ agentId: agents.agentId })
    .from(agents)
    .where(eq(hostColumn, id))
    .orderBy(asc(agents.agentId))) as { agentId: number }[];
  return { row, agentIds: pins.map((pin) => pin.agentId) };
}

/** A proxy host's sign-in grants are part of what an approver signs off on. */
async function hostState(kind: HostKind, id: number) {
  const stored = await hostRow(kind, id);
  if (!stored || kind === "l4") return stored;
  return { ...stored, access: await (await load.forwardAuth()).getForwardAuthAccessForHost(id) };
}

async function hostTarget(kind: HostKind, id: number | null, fallback?: unknown): Promise<Target> {
  const stored = id === null ? null : await hostRow(kind, id);
  const name = stored?.row.name ?? fallback;
  return { type: OBJECT[kind], id, name: typeof name === "string" ? name : null };
}

async function hostTags(kind: HostKind, ids: readonly number[], extra: unknown = []) {
  const tags = new Set<string>();
  for (const id of ids) {
    const stored = await hostRow(kind, id);
    for (const tag of parseStoredTags(stored?.row.tags as string | null)) tags.add(tag);
  }
  if (Array.isArray(extra)) {
    for (const tag of extra) if (typeof tag === "string") tags.add(tag.trim().toLowerCase());
  }
  return [...tags].sort();
}

const manageHost = (kind: HostKind, id: number): Need => ({
  capability: "hosts:write",
  object: { kind: OBJECT[kind], id },
});

const fields = (changes: AuditChange[]): ChangePreview => ({ type: "fields", changes });

async function hostDeletePreview(kind: HostKind, id: number): Promise<ChangePreview> {
  const stored = await hostRow(kind, id);
  if (!stored) throw domainError(kind === "http" ? "proxyHostNotFound" : "l4ProxyHostNotFound");
  const { hostFromSnapshot } = await import("../host-history");
  const host = hostFromSnapshot(kind, stored) as Record<string, unknown>;
  return fields(
    await (await import("../host-review/audit")).hostAuditChanges(
      kind,
      { host, agentIds: stored.agentIds },
      null,
      (kind === "http"
        ? (await import("../models/proxy-hosts")).blankProxyHost()
        : (await import("../models/l4-proxy-hosts")).blankL4ProxyHost()) as Record<string, unknown>,
    ),
  );
}

type ProxyHostCreate = {
  input: Partial<ProxyHostInput>;
  forwardAuthAccess?: ForwardAuthAccessInput;
};
type ProxyHostUpdate = ProxyHostCreate & { id: number; rollbackFrom?: number };
type L4HostCreate = { input: Partial<L4ProxyHostInput> };

/** The write options, only when there are some: a plain save passes none. */
const rollback = (p: { rollbackFrom?: number }): [] | [{ rollbackFrom: number }] =>
  p.rollbackFrom === undefined ? [] : [{ rollbackFrom: p.rollbackFrom }];
type L4HostUpdate = L4HostCreate & { id: number; rollbackFrom?: number };

async function bulkPreview(
  kind: HostKind,
  request: { action: string; ids: number[]; tag?: string },
): Promise<ChangePreview> {
  const names: string[] = [];
  for (const id of request.ids) {
    const stored = await hostRow(kind, id);
    names.push(typeof stored?.row.name === "string" ? stored.row.name : `#${id}`);
  }
  return fields(
    diffAuditRecords(
      { action: null, hosts: null },
      { action: request.tag ? `${request.action} ${request.tag}` : request.action, hosts: names },
    ),
  );
}

async function revisionHost(revisionId: number) {
  const revision = await (await load.hostHistory()).getHostRevision(revisionId);
  if (!revision) {
    throw domainError("hostRevisionNotFound", { revision: revisionId }, { status: 404 });
  }
  return revision;
}

// ── Access lists, WAF and settings ───────────────────────────────────

async function accessListState(id: number) {
  return await (await load.accessLists()).getAccessList(id);
}

function accessListRecord(list: AccessList | null) {
  if (!list) return null;
  const { entries, createdAt: _c, updatedAt: _u, ...rest } = list;
  return { ...rest, members: entries.map((entry) => entry.username).sort() };
}

async function exclusionRow(id: number) {
  const [row] = await db.select().from(wafExclusions).where(eq(wafExclusions.id, id));
  return row ?? null;
}

async function pluginRow(id: number) {
  const [row] = await db.select().from(crsPlugins).where(eq(crsPlugins.id, id));
  return row ?? null;
}

/** What a plugin's approver reads: never its rule bodies, which run to thousands of lines. */
function pluginRecord(row: Awaited<ReturnType<typeof pluginRow>>) {
  if (!row) return null;
  return { name: row.name, version: row.version, configOverride: row.configOverride ?? null };
}

function parseValue(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The changed keys, their fields, and the Caddy config with the change laid over it. */
export async function settingsPreview(entries: readonly SettingsEntry[]): Promise<ChangePreview> {
  const keys = entries.map((entry) => entry.key);
  const stored = await (await load.staging()).storedValues(keys);
  const changes = diffAuditRecords(
    Object.fromEntries(keys.map((key) => [key, parseValue(stored.get(key))])),
    Object.fromEntries(entries.map((entry) => [entry.key, parseValue(entry.value)])),
  );
  let config: ReturnType<typeof diffConfigDocuments> | null = null;
  try {
    const overlay = new Map(entries.map((entry) => [entry.key, entry.value]));
    const options = { includeAgentFileCertificates: true };
    const { buildCaddyDocument } = await load.caddy();
    const [current, next] = await Promise.all([
      buildCaddyDocument(undefined, options),
      withStagedReads(overlay, () => buildCaddyDocument(undefined, options)),
    ]);
    config = diffConfigDocuments(current, next);
  } catch (error) {
    // As the staged review: a throwing builder leaves the field diff to stand alone.
    console.error("Failed to render a change request's config diff:", error);
  }
  return { type: "settings", keys, changes, config };
}

async function settingsState(keys: readonly string[]) {
  return Object.fromEntries(await (await load.staging()).storedValues([...keys]));
}

export async function getApprovalPolicy(): Promise<ApprovalPolicy> {
  return readApprovalPolicy(await (await load.settings()).getSetting<unknown>(APPROVAL_POLICY_KEY));
}

// ── The catalogue ────────────────────────────────────────────────────

export const CHANGE_KIND_DEFINITIONS = {
  proxyHostCreate: define({
    area: "hosts",
    needs: () => [{ capability: "hosts:write" }],
    target: async (p: ProxyHostCreate) => hostTarget("http", null, p.input.name),
    tags: async (p) => hostTags("http", [], p.input.tags),
    state: async () => null,
    preview: async (p, requester) => ({
      type: "host",
      host: await (await load.hostReview()).previewProxyHostChange(
        { id: null, input: p.input, forwardAuthAccess: p.forwardAuthAccess },
        requester.userId,
      ),
    }),
    apply: async (p, actor) => {
      const host = await (await load.proxyHosts()).createProxyHost(
        p.input as ProxyHostInput,
        actor.userId,
      );
      if (p.forwardAuthAccess && host.cpmForwardAuth?.enabled) {
        await (await load.forwardAuth()).setForwardAuthAccess(
          host.id,
          p.forwardAuthAccess,
          actor.userId,
        );
      }
      return host;
    },
  }),
  proxyHostUpdate: define({
    area: "hosts",
    needs: (p: ProxyHostUpdate) => [manageHost("http", p.id)],
    target: async (p) => hostTarget("http", p.id),
    tags: async (p) => hostTags("http", [p.id], p.input.tags),
    state: async (p) => hostState("http", p.id),
    preview: async (p, requester) => ({
      type: "host",
      host: await (await load.hostReview()).previewProxyHostChange(
        { id: p.id, input: p.input, forwardAuthAccess: p.forwardAuthAccess },
        requester.userId,
      ),
    }),
    apply: async (p, actor) => {
      const host = await (await load.proxyHosts()).updateProxyHost(
        p.id,
        p.input,
        actor.userId,
        ...rollback(p),
      );
      if (p.forwardAuthAccess) {
        await (await load.forwardAuth()).setForwardAuthAccess(
          p.id,
          p.forwardAuthAccess,
          actor.userId,
        );
      }
      return host;
    },
  }),
  proxyHostDelete: define({
    area: "hosts",
    needs: (p: { id: number }) => [manageHost("http", p.id)],
    target: async (p) => hostTarget("http", p.id),
    tags: async (p) => hostTags("http", [p.id]),
    state: async (p) => hostState("http", p.id),
    preview: async (p) => hostDeletePreview("http", p.id),
    apply: async (p, actor) => {
      await (await load.proxyHosts()).deleteProxyHost(p.id, actor.userId);
      return true;
    },
  }),
  proxyHostMaintenance: define({
    area: "hosts",
    needs: (p: { id: number; enabled: boolean }) => [manageHost("http", p.id)],
    target: async (p) => hostTarget("http", p.id),
    tags: async (p) => hostTags("http", [p.id]),
    state: async (p) => hostState("http", p.id),
    preview: async (p) =>
      fields(diffAuditRecords({ maintenance: !p.enabled }, { maintenance: p.enabled })),
    apply: async (p, actor) => {
      await (await load.proxyHosts()).setProxyHostMaintenance(p.id, p.enabled, actor.userId);
      return true;
    },
  }),
  proxyHostBulk: define({
    area: "hosts",
    needs: (p: ProxyHostBulkRequest) => p.ids.map((id) => manageHost("http", id)),
    target: async (p) => ({ type: "proxyHost", id: null, name: `${p.ids.length}` }),
    tags: async (p) => hostTags("http", p.ids, p.tag ? [p.tag] : []),
    state: async (p) => Promise.all(p.ids.map((id) => hostState("http", id))),
    preview: async (p) => bulkPreview("http", p),
    apply: async (p, actor) =>
      (await (await load.bulk()).bulkUpdateProxyHosts(p, actor.userId)).count,
  }),
  forwardAuthAccess: define({
    area: "hosts",
    needs: (p: { hostId: number; access: ForwardAuthAccessInput }) => [
      manageHost("http", p.hostId),
    ],
    target: async (p) => hostTarget("http", p.hostId),
    tags: async (p) => hostTags("http", [p.hostId]),
    state: async (p) => hostState("http", p.hostId),
    preview: async (p, requester) => ({
      type: "host",
      host: await (await load.hostReview()).previewProxyHostChange(
        { id: p.hostId, input: {}, forwardAuthAccess: p.access },
        requester.userId,
      ),
    }),
    apply: async (p, actor) =>
      (await load.forwardAuth()).setForwardAuthAccess(p.hostId, p.access, actor.userId),
  }),
  mtlsRuleCreate: define({
    area: "hosts",
    needs: (p: { input: MtlsAccessRuleInput }) => [manageHost("http", p.input.proxyHostId)],
    target: async (p) => hostTarget("http", p.input.proxyHostId),
    tags: async (p) => hostTags("http", [p.input.proxyHostId]),
    state: async (p) => hostState("http", p.input.proxyHostId),
    preview: async (p) => fields(diffAuditRecords(null, { ...p.input })),
    apply: async (p, actor) => (await load.mtls()).createMtlsAccessRule(p.input, actor.userId),
  }),
  mtlsRuleUpdate: define({
    area: "hosts",
    // The API is the only way in, and it needs hosts:write over every host.
    needs: (_p: { id: number; input: Partial<MtlsAccessRuleInput> }) => [
      { capability: "hosts:write" },
    ],
    target: async (p) => hostTarget("http", (await requireRule(p.id)).proxyHostId),
    tags: async (p) => hostTags("http", [(await requireRule(p.id)).proxyHostId]),
    state: async (p) => (await load.mtls()).getMtlsAccessRule(p.id),
    preview: async (p) => {
      const rule = await requireRule(p.id);
      return fields(diffAuditRecords({ ...rule }, { ...rule, ...p.input }));
    },
    apply: async (p, actor) =>
      (await load.mtls()).updateMtlsAccessRule(p.id, p.input, actor.userId),
  }),
  mtlsRuleDelete: define({
    area: "hosts",
    needs: (_p: { id: number }) => [{ capability: "hosts:write" }],
    target: async (p) => hostTarget("http", (await requireRule(p.id)).proxyHostId),
    tags: async (p) => hostTags("http", [(await requireRule(p.id)).proxyHostId]),
    state: async (p) => (await load.mtls()).getMtlsAccessRule(p.id),
    preview: async (p) => fields(diffAuditRecords({ ...(await requireRule(p.id)) }, null)),
    apply: async (p, actor) => {
      await (await load.mtls()).deleteMtlsAccessRule(p.id, actor.userId);
      return true;
    },
  }),
  l4HostCreate: define({
    area: "hosts",
    needs: () => [{ capability: "hosts:write" }],
    target: async (p: L4HostCreate) => hostTarget("l4", null, p.input.name),
    tags: async (p) => hostTags("l4", [], p.input.tags),
    state: async () => null,
    preview: async (p, requester) => ({
      type: "host",
      host: await (await load.hostReview()).previewL4HostChange(
        { id: null, input: p.input },
        requester.userId,
      ),
    }),
    apply: async (p, actor) =>
      (await load.l4()).createL4ProxyHost(p.input as L4ProxyHostInput, actor.userId),
  }),
  l4HostUpdate: define({
    area: "hosts",
    needs: (p: L4HostUpdate) => [manageHost("l4", p.id)],
    target: async (p) => hostTarget("l4", p.id),
    tags: async (p) => hostTags("l4", [p.id], p.input.tags),
    state: async (p) => hostState("l4", p.id),
    preview: async (p, requester) => ({
      type: "host",
      host: await (await load.hostReview()).previewL4HostChange(
        { id: p.id, input: p.input },
        requester.userId,
      ),
    }),
    apply: async (p, actor) =>
      (await load.l4()).updateL4ProxyHost(p.id, p.input, actor.userId, ...rollback(p)),
  }),
  l4HostDelete: define({
    area: "hosts",
    needs: (p: { id: number }) => [manageHost("l4", p.id)],
    target: async (p) => hostTarget("l4", p.id),
    tags: async (p) => hostTags("l4", [p.id]),
    state: async (p) => hostState("l4", p.id),
    preview: async (p) => hostDeletePreview("l4", p.id),
    apply: async (p, actor) => {
      await (await load.l4()).deleteL4ProxyHost(p.id, actor.userId);
      return true;
    },
  }),
  l4HostBulk: define({
    area: "hosts",
    needs: (p: L4HostBulkRequest) => p.ids.map((id) => manageHost("l4", id)),
    target: async (p) => ({ type: "l4ProxyHost", id: null, name: `${p.ids.length}` }),
    tags: async (p) => hostTags("l4", p.ids, p.tag ? [p.tag] : []),
    state: async (p) => Promise.all(p.ids.map((id) => hostState("l4", id))),
    preview: async (p) => bulkPreview("l4", p),
    apply: async (p, actor) =>
      (await (await load.bulk()).bulkUpdateL4ProxyHosts(p, actor.userId)).count,
  }),
  hostRollback: define({
    area: "hosts",
    needs: () => [{ capability: "hosts:write" }],
    target: async (p: { revisionId: number }) => {
      const revision = await revisionHost(p.revisionId);
      return hostTarget(revision.hostKind, revision.hostId);
    },
    tags: async (p) => {
      const revision = await revisionHost(p.revisionId);
      return hostTags(
        revision.hostKind,
        [revision.hostId],
        parseStoredTags(revision.snapshot.row.tags as string | null),
      );
    },
    state: async (p) => {
      const revision = await revisionHost(p.revisionId);
      return hostState(revision.hostKind, revision.hostId);
    },
    preview: async (p) => {
      const revision = await revisionHost(p.revisionId);
      const stored = await hostRow(revision.hostKind, revision.hostId);
      if (!stored) throw domainError("hostRollbackGone", {}, { status: 409 });
      const { hostFromSnapshot } = await import("../host-history");
      return fields(
        await (await load.hostHistory()).auditChangesFor(
          revision.hostKind,
          {
            host: hostFromSnapshot(revision.hostKind, stored) as Record<string, unknown>,
            agentIds: stored.agentIds,
          },
          revision.snapshot,
        ),
      );
    },
    apply: async (p, actor) => (await load.hostHistory()).rollbackHost(p.revisionId, actor.userId),
  }),
  hostRestore: define({
    area: "hosts",
    needs: () => [{ capability: "hosts:write" }],
    target: async (p: { revisionId: number; dropMissingReferences: boolean; kind?: HostKind }) => {
      const revision = await revisionHost(p.revisionId);
      const name = revision.snapshot.row.name;
      return {
        type: OBJECT[revision.hostKind],
        id: revision.hostId,
        name: typeof name === "string" ? name : null,
      };
    },
    tags: async (p) => {
      const revision = await revisionHost(p.revisionId);
      return parseStoredTags(revision.snapshot.row.tags as string | null);
    },
    state: async (p) => {
      const revision = await revisionHost(p.revisionId);
      return hostState(revision.hostKind, revision.hostId);
    },
    preview: async (p) => {
      const revision = await revisionHost(p.revisionId);
      if (p.kind && revision.hostKind !== p.kind) {
        throw domainError("hostRevisionNotFound", { revision: p.revisionId }, { status: 404 });
      }
      return fields(
        await (await load.hostHistory()).auditChangesFor(
          revision.hostKind,
          null,
          revision.snapshot,
        ),
      );
    },
    apply: async (p, actor) =>
      (await load.hostHistory()).restoreHost(p.revisionId, actor.userId, {
        dropMissingReferences: p.dropMissingReferences,
        kind: p.kind,
      }),
  }),

  accessListCreate: define({
    area: "accessLists",
    needs: () => [{ capability: "accessLists:write" }],
    target: async (p: { input: AccessListInput }) => ({
      type: "accessList",
      id: null,
      name: typeof p.input.name === "string" ? p.input.name : null,
    }),
    state: async () => null,
    preview: async (p) => {
      const { users, ...rest } = p.input;
      return fields(
        diffAuditRecords(null, {
          ...rest,
          members: (users ?? []).map((user) => user.username).sort(),
        }),
      );
    },
    apply: async (p, actor) => (await load.accessLists()).createAccessList(p.input, actor.userId),
  }),
  accessListUpdate: define({
    area: "accessLists",
    needs: () => [{ capability: "accessLists:write" }],
    target: async (p: { id: number; input: AccessListSettingsInput }) => accessListTarget(p.id),
    state: async (p) => accessListState(p.id),
    preview: async (p) => {
      const before = accessListRecord(await requireAccessList(p.id));
      return fields(diffAuditRecords(before, { ...before, ...p.input }));
    },
    apply: async (p, actor) =>
      (await load.accessLists()).updateAccessList(p.id, p.input, actor.userId),
  }),
  accessListDelete: define({
    area: "accessLists",
    needs: () => [{ capability: "accessLists:write" }],
    target: async (p: { id: number }) => accessListTarget(p.id),
    state: async (p) => accessListState(p.id),
    preview: async (p) =>
      fields(diffAuditRecords(accessListRecord(await requireAccessList(p.id)), null)),
    apply: async (p, actor) => {
      await (await load.accessLists()).deleteAccessList(p.id, actor.userId);
      return true;
    },
  }),
  accessListRules: define({
    area: "accessLists",
    needs: () => [{ capability: "accessLists:write" }],
    target: async (p: { id: number; rules: unknown }) => accessListTarget(p.id),
    state: async (p) => accessListState(p.id),
    preview: async (p) => {
      const list = await requireAccessList(p.id);
      return fields(diffAuditRecords({ ipRules: list.ipRules }, { ipRules: p.rules }));
    },
    apply: async (p, actor) =>
      (await load.accessLists()).setAccessListIpRules(p.id, p.rules, actor.userId),
  }),
  accessListEntryAdd: define({
    area: "accessLists",
    needs: () => [{ capability: "accessLists:write" }],
    target: async (p: { id: number; entry: { username: string; password: string } }) =>
      accessListTarget(p.id),
    state: async (p) => accessListState(p.id),
    preview: async (p) => {
      const members = (await requireAccessList(p.id)).entries.map((entry) => entry.username);
      return fields(
        diffAuditRecords(
          { members: [...members].sort() },
          {
            members: [...members, p.entry.username].sort(),
          },
        ),
      );
    },
    apply: async (p, actor) =>
      (await load.accessLists()).addAccessListEntry(p.id, p.entry, actor.userId),
  }),
  accessListEntryRemove: define({
    area: "accessLists",
    needs: () => [{ capability: "accessLists:write" }],
    target: async (p: { id: number; entryIds: number[] }) => accessListTarget(p.id),
    state: async (p) => accessListState(p.id),
    preview: async (p) => {
      const entries = (await requireAccessList(p.id)).entries;
      const members = entries.map((entry) => entry.username).sort();
      const kept = entries
        .filter((entry) => !p.entryIds.includes(entry.id))
        .map((entry) => entry.username)
        .sort();
      return fields(diffAuditRecords({ members }, { members: kept }));
    },
    // One entry the way the single delete always removed one, so its refusals stay the same.
    apply: async (p, actor) => {
      const lists = await load.accessLists();
      return p.entryIds.length === 1
        ? lists.removeAccessListEntry(p.id, p.entryIds[0], actor.userId)
        : lists.removeAccessListEntries(p.id, p.entryIds, actor.userId);
    },
  }),

  wafPresetCreate: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { input: WafPresetInput }) => ({
      type: "wafPreset",
      id: null,
      name: p.input.name?.trim() || null,
    }),
    state: async () => null,
    preview: async (p) => fields(diffAuditRecords(null, { ...p.input })),
    apply: async (p, actor) => (await load.wafPresets()).createWafPreset(p.input, actor.userId),
  }),
  wafPresetUpdate: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { id: number; input: Partial<WafPresetInput> }) => presetTarget(p.id),
    state: async (p) => (await load.wafPresets()).getWafPreset(p.id),
    preview: async (p) => {
      const before = await requirePreset(p.id);
      return fields(diffAuditRecords({ ...before }, { ...before, ...p.input }));
    },
    apply: async (p, actor) =>
      (await load.wafPresets()).updateWafPreset(p.id, p.input, actor.userId),
  }),
  wafPresetDelete: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { id: number }) => presetTarget(p.id),
    state: async (p) => (await load.wafPresets()).getWafPreset(p.id),
    preview: async (p) => fields(diffAuditRecords({ ...(await requirePreset(p.id)) }, null)),
    apply: async (p, actor) => {
      await (await load.wafPresets()).deleteWafPreset(p.id, actor.userId);
      return true;
    },
  }),
  wafExclusionCreate: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { input: WafExclusionInput }) => ({
      type: "wafExclusion",
      id: null,
      name: String(p.input.ruleId),
    }),
    state: async () => null,
    preview: async (p) => fields(diffAuditRecords(null, { ...p.input })),
    apply: async (p, actor) =>
      (await load.wafExclusions()).createWafExclusion(p.input, actor.userId),
  }),
  wafExclusionUpdate: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { id: number; input: WafExclusionInput }) => exclusionTarget(p.id),
    state: async (p) => exclusionRow(p.id),
    preview: async (p) => {
      const before = await requireExclusion(p.id);
      return fields(
        diffAuditRecords(exclusionRecord(before), { ...exclusionRecord(before), ...p.input }),
      );
    },
    apply: async (p, actor) =>
      (await load.wafExclusions()).updateWafExclusion(p.id, p.input, actor.userId),
  }),
  wafExclusionDelete: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { id: number }) => exclusionTarget(p.id),
    state: async (p) => exclusionRow(p.id),
    preview: async (p) =>
      fields(diffAuditRecords(exclusionRecord(await requireExclusion(p.id)), null)),
    apply: async (p, actor) => {
      await (await load.wafExclusions()).deleteWafExclusion(p.id, actor.userId);
      return true;
    },
  }),
  crsPluginInstall: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { registryId: string; name: string }) => ({
      type: "crsPlugin",
      id: null,
      name: p.name,
    }),
    state: async () => null,
    preview: async (p) => fields(diffAuditRecords(null, { name: p.name, registry: p.registryId })),
    apply: async (p, actor) =>
      (await load.crs()).installCrsPlugin(p.registryId, p.name, actor.userId),
  }),
  crsPluginUpdate: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { id: number }) => pluginTarget(p.id),
    state: async (p) => pluginRow(p.id),
    preview: async (p) => {
      const before = pluginRecord(await requirePlugin(p.id));
      return fields(diffAuditRecords(before, { ...before, version: null }));
    },
    apply: async (p, actor) => (await load.crs()).updateCrsPlugin(p.id, actor.userId),
  }),
  crsPluginConfig: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { id: number; config: string | null }) => pluginTarget(p.id),
    state: async (p) => pluginRow(p.id),
    preview: async (p) => {
      const before = pluginRecord(await requirePlugin(p.id));
      return fields(diffAuditRecords(before, { ...before, configOverride: p.config }));
    },
    apply: async (p, actor) => (await load.crs()).setCrsPluginConfig(p.id, p.config, actor.userId),
  }),
  crsPluginUninstall: define({
    area: "waf",
    needs: () => [{ capability: "security:write" }],
    target: async (p: { id: number }) => pluginTarget(p.id),
    state: async (p) => pluginRow(p.id),
    preview: async (p) => fields(diffAuditRecords(pluginRecord(await requirePlugin(p.id)), null)),
    apply: async (p, actor) => {
      await (await load.crs()).uninstallCrsPlugin(p.id, actor.userId);
      return true;
    },
  }),

  settingsApply: define({
    area: "settings",
    needs: () => [{ capability: "settings:write" }],
    target: async (p: { entries: SettingsEntry[] }) => ({
      type: "settings",
      id: null,
      name: p.entries.map((entry) => entry.key).join(", "),
    }),
    state: async (p) => settingsState(p.entries.map((entry) => entry.key)),
    preview: async (p) => settingsPreview(p.entries),
    apply: async (p, actor) =>
      (await load.settingsApply()).applySettingsEntries(actor.userId, actor.name, p.entries),
  }),
  settingsGroup: define({
    area: "settings",
    needs: () => [{ capability: "settings:write" }],
    target: async (p: { group: string; input: unknown }) => ({
      type: "settings",
      id: null,
      name: p.group,
    }),
    state: async (p) =>
      settingsState([(await load.settingsApi()).settingsGroupKey(p.group) ?? p.group]),
    preview: async (p) => {
      const writes = await (await load.settingsApi()).captureSettingsGroupWrites(p.group, p.input);
      return settingsPreview([...writes].map(([key, value]) => ({ key, value })));
    },
    apply: async (p) => {
      await (await load.settingsApi()).saveSettingsGroup(p.group, p.input);
      return true;
    },
  }),
  approvalPolicy: define({
    area: "settings",
    needs: () => [{ capability: "settings:write" }],
    target: async () => ({ type: "approvalPolicy", id: null, name: null }),
    state: async () => settingsState([APPROVAL_POLICY_KEY]),
    preview: async (p: { policy: ApprovalPolicy }) => {
      const problem = approvalPolicyProblem(p.policy);
      if (problem) throw domainError(problem, {}, { status: 400 });
      return fields(diffAuditRecords({ ...(await getApprovalPolicy()) }, { ...p.policy }));
    },
    apply: async (p, actor) => saveApprovalPolicy(p.policy, actor.userId),
  }),
} satisfies Record<ChangeKind, KindDefinition<never, unknown>>;

export type ChangeKindDefinitions = typeof CHANGE_KIND_DEFINITIONS;
export type PayloadOf<K extends ChangeKind> = Parameters<ChangeKindDefinitions[K]["apply"]>[0];
export type ResultOf<K extends ChangeKind> = Awaited<ReturnType<ChangeKindDefinitions[K]["apply"]>>;

/** The same lookup, untyped: a stored request's kind is only known at runtime. */
export function kindDefinition(kind: ChangeKind): KindDefinition<unknown, unknown> {
  return CHANGE_KIND_DEFINITIONS[kind] as unknown as KindDefinition<unknown, unknown>;
}

async function requireRule(id: number) {
  const rule = await (await load.mtls()).getMtlsAccessRule(id);
  if (!rule) throw domainError("mtlsAccessRuleNotFound", {}, { status: 404 });
  return rule;
}

async function requireAccessList(id: number) {
  const list = await (await load.accessLists()).getAccessList(id);
  if (!list) throw domainError("accessListNotFound");
  return list;
}

async function accessListTarget(id: number): Promise<Target> {
  return {
    type: "accessList",
    id,
    name: (await (await load.accessLists()).getAccessList(id))?.name ?? null,
  };
}

async function requirePreset(id: number) {
  const preset = await (await load.wafPresets()).getWafPreset(id);
  if (!preset) throw domainError("wafPresetNotFound", {}, { status: 404 });
  return preset;
}

async function presetTarget(id: number): Promise<Target> {
  return {
    type: "wafPreset",
    id,
    name: (await (await load.wafPresets()).getWafPreset(id))?.name ?? null,
  };
}

async function requireExclusion(id: number) {
  const row = await exclusionRow(id);
  if (!row) throw domainError("wafExclusionNotFound", {}, { status: 404 });
  return row;
}

function exclusionRecord(row: NonNullable<Awaited<ReturnType<typeof exclusionRow>>>) {
  return {
    ruleId: row.ruleId,
    proxyHostId: row.proxyHostId,
    path: row.path,
    target: row.target,
    reason: row.reason,
  } as Record<string, unknown>;
}

async function exclusionTarget(id: number): Promise<Target> {
  const row = await exclusionRow(id);
  return { type: "wafExclusion", id, name: row ? String(row.ruleId) : null };
}

async function requirePlugin(id: number) {
  const row = await pluginRow(id);
  if (!row) throw domainError("crsPluginNotFound", {}, { status: 404 });
  return row;
}

async function pluginTarget(id: number): Promise<Target> {
  return { type: "crsPlugin", id, name: (await pluginRow(id))?.name ?? null };
}

/** Straight to the row: it holds no Caddy config, so there is nothing to stage or push. */
export async function saveApprovalPolicy(policy: ApprovalPolicy, actorUserId: number) {
  const problem = approvalPolicyProblem(policy);
  if (problem) throw domainError(problem, {}, { status: 400 });
  const before = await getApprovalPolicy();
  await (await load.settings()).setSetting(APPROVAL_POLICY_KEY, policy);
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "approval_policy",
    summary: "Updated the change approval policy",
    changes: diffAuditRecords({ ...before }, { ...policy }),
  });
  return policy;
}
