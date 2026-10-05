/**
 * The review step behind the host editors, GraphQL and REST: runs every check a save would, then
 * returns the field diff and what the save would set off, storing nothing. The diff compares the
 * stored host with the one the model would write, so it cannot drift from the save itself.
 */

import { listAgentOptions } from "../agent/client";
import { isDomainCoveredByCert, isDomainCoveredByWildcard } from "../certificates/domain-match";
import { getAccessList } from "../models/access-lists";
import { listCertificates } from "../models/certificates";
import { getForwardAuthAccessForHost } from "../models/forward-auth";
import { listGroups } from "../models/groups";
import {
  type L4ProxyHost,
  type L4ProxyHostInput,
  blankL4ProxyHost,
  planL4ProxyHostChange,
} from "../models/l4-proxy-hosts";
import {
  type ProxyHost,
  type ProxyHostInput,
  blankProxyHost,
  listProxyHosts,
  planProxyHostChange,
} from "../models/proxy-hosts";
import { listUsers } from "../models/user";
import type { ForwardAuthAccessInput } from "../proxy-hosts/form";
import { hostProtections } from "../proxy-hosts/protections";
import type { GlobalRateLimitSettings } from "../proxy-hosts/rate-limit";
import { getCrowdSecSettings, getRateLimitSettings } from "../settings";
import { CONFIG_NEUTRAL_FIELDS, diffHostFields, withoutReverted } from "./diff";
import type {
  FieldChange,
  HostChangeImpact,
  HostChangePreview,
  ImpactAgent,
  ImpactWarning,
} from "./types";

export type ProxyHostPreviewRequest = {
  /** Null previews a create. */
  id: number | null;
  input: Partial<ProxyHostInput>;
  forwardAuthAccess?: ForwardAuthAccessInput;
  /** Fields the review's undo took out; the rest of the input stands. */
  reverted?: readonly string[];
};

export type L4HostPreviewRequest = {
  id: number | null;
  input: Partial<L4ProxyHostInput>;
  reverted?: readonly string[];
};

/** Applies the review's undo to what a save would send, as the save actions do. */
export function revertProxyHostInput<T extends { input: Partial<ProxyHostInput> }>(
  parsed: T & { forwardAuthAccess?: ForwardAuthAccessInput },
  reverted: readonly string[],
  isCreate: boolean,
): T & { forwardAuthAccess?: ForwardAuthAccessInput } {
  return {
    ...parsed,
    input: withoutReverted("http", parsed.input, reverted, isCreate),
    forwardAuthAccess: reverted.includes("cpmForwardAuthAccess")
      ? undefined
      : parsed.forwardAuthAccess,
  };
}

type Names = Map<number, string>;

function namesOf(ids: readonly number[], names: Names): string[] {
  return ids.map((id) => names.get(id) ?? `#${id}`).sort((a, b) => a.localeCompare(b));
}

function warn(
  code: ImpactWarning["code"],
  values: ImpactWarning["values"] = {},
  severity: ImpactWarning["severity"] = "warning",
): ImpactWarning {
  return { code, severity, values };
}

/** Before or after, the agents a host is on; empty means every agent. */
function agentImpact(
  agents: ImpactAgent[],
  before: readonly number[],
  after: readonly number[],
  isCreate: boolean,
): Pick<HostChangeImpact, "agents" | "everyAgent" | "pinned" | "pinChanged"> {
  const everyAgent = after.length === 0;
  const touched =
    everyAgent || (!isCreate && before.length === 0)
      ? agents
      : agents.filter((agent) => before.includes(agent.id) || after.includes(agent.id));
  const pinChanged =
    !isCreate &&
    (before.length !== after.length || before.some((id, index) => after[index] !== id));
  return { agents: touched, everyAgent, pinned: !everyAgent, pinChanged };
}

function offlineWarnings(agents: ImpactAgent[]): ImpactWarning[] {
  return agents
    .filter((agent) => !agent.connected)
    .map((agent) => warn("agentOffline", { agent: agent.name }, "info"));
}

async function accessListWarnings(id: number | null, layer4: boolean): Promise<ImpactWarning[]> {
  if (id === null) return [];
  const list = await getAccessList(id);
  if (!list) return [];
  const out: ImpactWarning[] = [];
  const name = list.name;
  if (list.entries.length === 0 && list.ipRules.length === 0)
    out.push(warn("accessListEmpty", { name }));
  if (list.ipRules.some((rule) => rule.country || rule.continent || rule.asn)) {
    out.push(warn("accessListGeoRules", { name }, "info"));
  }
  if (!layer4 && list.denyResponse) {
    out.push(warn("accessListDenyResponse", { name, status: list.denyResponse.status }, "info"));
  }
  if (!layer4 && list.failClosed) out.push(warn("accessListFailClosed", { name }));
  return out;
}

function rateLimitZones(host: ProxyHost, global: GlobalRateLimitSettings | null) {
  const mode = host.rateLimit?.mode ?? "inherit";
  const own = host.rateLimit?.enabled && mode !== "inherit" ? host.rateLimit.zones.length : 0;
  const inherited = global?.enabled && mode !== "override" ? global.zones.length : 0;
  return { mode, own, inherited };
}

function sortedIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

export async function previewProxyHostChange(
  request: ProxyHostPreviewRequest,
  actorUserId: number,
): Promise<HostChangePreview> {
  const isCreate = request.id === null;
  const { input, forwardAuthAccess } = revertProxyHostInput(
    { input: request.input, forwardAuthAccess: request.forwardAuthAccess },
    request.reverted ?? [],
    isCreate,
  );
  const { before, after, agentIdsBefore } = await planProxyHostChange(
    request.id,
    input,
    actorUserId,
  );
  const agentIdsAfter = sortedIds(input.agentIds ?? agentIdsBefore);

  const [agents, certificates, hosts, crowdsec, rateLimit, users, groups, accessBefore] =
    await Promise.all([
      listAgentOptions().catch(() => []),
      listCertificates(),
      listProxyHosts(),
      getCrowdSecSettings().catch(() => null),
      getRateLimitSettings().catch(() => null),
      forwardAuthAccess || request.id !== null ? listUsers() : Promise.resolve([]),
      forwardAuthAccess || request.id !== null ? listGroups() : Promise.resolve([]),
      request.id !== null ? getForwardAuthAccessForHost(request.id) : Promise.resolve([]),
    ]);
  const agentNames: Names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const certificateNames: Names = new Map(certificates.map((cert) => [cert.id, cert.name]));
  const userNames: Names = new Map(users.map((user) => [user.id, user.email]));
  const groupNames: Names = new Map(groups.map((group) => [group.id, group.name]));
  const listNames: Names = new Map();
  for (const id of [before?.accessListId, after.accessListId]) {
    if (id == null || listNames.has(id)) continue;
    listNames.set(id, (await getAccessList(id))?.name ?? `#${id}`);
  }

  const storedAccess = {
    userIds: accessBefore.flatMap((entry) => (entry.userId ? [entry.userId] : [])),
    groupIds: accessBefore.flatMap((entry) => (entry.groupId ? [entry.groupId] : [])),
  };
  const record = (host: ProxyHost, agentIds: number[], access: ForwardAuthAccessInput) => ({
    ...host,
    agentIds: namesOf(agentIds, agentNames),
    certificateId:
      host.certificateId === null
        ? null
        : (certificateNames.get(host.certificateId) ?? `#${host.certificateId}`),
    accessListId: host.accessListId === null ? null : (listNames.get(host.accessListId) ?? null),
    cpmForwardAuthAccess: {
      users: namesOf(access.userIds, userNames),
      groups: namesOf(access.groupIds, groupNames),
    },
  });
  const changes = diffHostFields(
    "http",
    before ? record(before, agentIdsBefore, storedAccess) : null,
    record(after, agentIdsAfter, forwardAuthAccess ?? storedAccess),
    record(blankProxyHost(), [], { userIds: [], groupIds: [] }),
  );

  const reload = isCreate || changes.some((c) => !CONFIG_NEUTRAL_FIELDS.includes(c.field));
  const placement = agentImpact(agents, agentIdsBefore, agentIdsAfter, isCreate);
  const warnings: ImpactWarning[] = [];

  // Certificates: new names under automatic TLS that nothing already holds a certificate for.
  const requested: HostChangeImpact["certificates"] = [];
  if (after.enabled && after.certificateId === null) {
    const already = new Set(before?.enabled && before.certificateId === null ? before.domains : []);
    const imported = certificates.filter((cert) => cert.type === "imported");
    const wildcards = hosts
      .filter((h) => h.id !== request.id && h.enabled && h.certificateId === null)
      .flatMap((h) => h.domains.filter((d) => d.startsWith("*.")));
    for (const domain of after.domains) {
      if (already.has(domain)) continue;
      if (imported.some((cert) => isDomainCoveredByCert(domain, cert.domainNames))) continue;
      if (isDomainCoveredByWildcard(domain, wildcards)) continue;
      requested.push({ domain, wildcard: domain.startsWith("*.") });
    }
  } else if (after.certificateId !== null) {
    const cert = certificates.find((c) => c.id === after.certificateId);
    if (cert?.type === "imported") {
      for (const domain of after.domains) {
        if (!isDomainCoveredByCert(domain, cert.domainNames)) {
          warnings.push(warn("certificateDoesNotCover", { domain, certificate: cert.name }));
        }
      }
    }
  }

  const known = new Set((before?.domains ?? []).map((d) => d.toLowerCase()));
  for (const domain of after.domains) {
    const lower = domain.toLowerCase();
    if (known.has(lower)) continue;
    const other = hosts.find(
      (h) => h.id !== request.id && h.domains.some((d) => d.toLowerCase() === lower),
    );
    if (other) warnings.push(warn("domainInUse", { domain, host: other.name }));
  }

  if (before) {
    const crowdsecActive = crowdsec?.enabled ?? false;
    const was = hostProtections(before, crowdsecActive);
    const now = hostProtections(after, crowdsecActive);
    for (const protection of was.active) {
      if (protection === "rateLimit") continue;
      if (protection === "signIn" && now.signIn !== null) {
        if (now.signIn !== was.signIn) {
          warnings.push(warn("signInChanged", { from: was.signIn ?? "", to: now.signIn }));
        }
        continue;
      }
      if (!now.active.includes(protection)) {
        warnings.push(warn("protectionRemoved", { protection }));
      }
    }
    if (
      before.waf?.enabled &&
      after.waf?.enabled &&
      before.waf.mode !== "DetectionOnly" &&
      after.waf.mode === "DetectionOnly"
    ) {
      warnings.push(warn("wafDetectionOnly"));
    }
    const zonesBefore = rateLimitZones(before, rateLimit);
    const zonesAfter = rateLimitZones(after, rateLimit);
    if (
      zonesBefore.own + zonesBefore.inherited > 0 &&
      zonesAfter.own + zonesAfter.inherited === 0
    ) {
      warnings.push(warn("protectionRemoved", { protection: "rateLimit" }));
    } else if (zonesBefore.mode !== zonesAfter.mode) {
      warnings.push(
        warn(
          "rateLimitModeChanged",
          {
            from: zonesBefore.mode,
            to: zonesAfter.mode,
            own: zonesAfter.own,
            inherited: zonesAfter.inherited,
          },
          "info",
        ),
      );
    }
    if (before.enabled && !after.enabled) warnings.push(warn("hostDisabled"));
    if (!before.maintenance?.enabled && after.maintenance?.enabled) {
      warnings.push(warn("maintenanceOn"));
    }
  }
  if (after.accessListId !== (before?.accessListId ?? null)) {
    warnings.push(...(await accessListWarnings(after.accessListId, false)));
  }
  if (reload) warnings.push(...offlineWarnings(placement.agents));

  return {
    kind: "http",
    hostId: request.id,
    changes,
    impact: {
      reload,
      ...(reload ? placement : { ...placement, agents: [] }),
      certificates: requested,
      warnings,
    },
  };
}

function l4Record(
  host: L4ProxyHost,
  agentIds: number[],
  agentNames: Names,
  listName: string | null,
) {
  return {
    ...host,
    agentIds: namesOf(agentIds, agentNames),
    accessListId: host.accessListId === null ? null : listName,
  };
}

export async function previewL4HostChange(
  request: L4HostPreviewRequest,
  actorUserId: number,
): Promise<HostChangePreview> {
  const isCreate = request.id === null;
  const input = withoutReverted("l4", request.input, request.reverted ?? [], isCreate);
  const { before, after, agentIdsBefore } = await planL4ProxyHostChange(
    request.id,
    input,
    actorUserId,
  );
  const agentIdsAfter = sortedIds(input.agentIds ?? agentIdsBefore);
  const [agents, crowdsec] = await Promise.all([
    listAgentOptions().catch(() => []),
    getCrowdSecSettings().catch(() => null),
  ]);
  const agentNames: Names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const listName = async (id: number | null) =>
    id === null ? null : ((await getAccessList(id))?.name ?? `#${id}`);

  const changes = diffHostFields(
    "l4",
    before
      ? l4Record(before, agentIdsBefore, agentNames, await listName(before.accessListId))
      : null,
    l4Record(after, agentIdsAfter, agentNames, await listName(after.accessListId)),
    l4Record(blankL4ProxyHost(), [], agentNames, null),
  );
  const reload = isCreate || changes.some((c) => !CONFIG_NEUTRAL_FIELDS.includes(c.field));
  const placement = agentImpact(agents, agentIdsBefore, agentIdsAfter, isCreate);
  const warnings: ImpactWarning[] = [];

  const portsMove =
    isCreate ||
    !before?.enabled ||
    before.listenAddress !== after.listenAddress ||
    before.protocol !== after.protocol ||
    placement.pinChanged;
  if (after.enabled && portsMove) {
    warnings.push(warn("l4PortsApply", { listen: after.listenAddress }, "info"));
  }
  if (before) {
    if (before.accessListId !== null && after.accessListId === null) {
      warnings.push(warn("protectionRemoved", { protection: "accessList" }));
    }
    if (before.geoblock?.enabled && !after.geoblock?.enabled) {
      warnings.push(warn("protectionRemoved", { protection: "geo" }));
    }
    if ((crowdsec?.enabled ?? false) && before.crowdsec && !after.crowdsec) {
      warnings.push(warn("protectionRemoved", { protection: "crowdsec" }));
    }
    if (before.enabled && !after.enabled) warnings.push(warn("hostDisabled"));
  }
  if (after.accessListId !== (before?.accessListId ?? null)) {
    warnings.push(...(await accessListWarnings(after.accessListId, true)));
  }
  if (reload) warnings.push(...offlineWarnings(placement.agents));

  return {
    kind: "l4",
    hostId: request.id,
    changes: changes satisfies FieldChange[],
    impact: {
      reload,
      ...(reload ? placement : { ...placement, agents: [] }),
      certificates: [],
      warnings,
    },
  };
}
