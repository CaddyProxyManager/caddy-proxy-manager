/**
 * Every permission check goes through `can()`. A role holds capabilities (`lib/roles`); a scoped
 * role holds its object-bound ones only over what its groups are granted, which is how `operator`
 * works. Grants mean nothing to a capability held outright, so no arrangement of groups narrows
 * an administrator.
 */

import type { Session } from "../auth";
import { requestMemo } from "../request-memo";
import { DomainError, domainErrorMessage } from "../errors/domain-error";
import {
  type EffectiveGrants,
  type GrantCapability,
  emptyGrants,
  grantsForGroups,
  groupIdsOf,
  rolesOfGroups,
} from "../models/group-grants";
import {
  CAPABILITIES,
  type Capability,
  type CapabilitySet,
  type ObjectKind,
  capabilitySetOf,
  holds,
  reaches,
  resourceOfKind,
  splitCapability,
} from "../roles/capabilities";
import { BUILT_IN_ROLES } from "../roles/built-in";
import { roleDefinitions } from "../roles";

export type ResourceKind = ObjectKind;

export type ObjectRef = { kind: ObjectKind; id: number };

/** What the current viewer may do, resolved once per request. */
export type Access = {
  userId: number;
  role: string;
  capabilities: CapabilitySet;
  /** Read only for capabilities a scoped role holds. */
  grants: EffectiveGrants;
};

/** A `DomainError`, so an action says it in the reader's language. */
export class ForbiddenError extends DomainError {
  constructor() {
    super("accessDenied", {}, domainErrorMessage("accessDenied"));
    this.name = "ForbiddenError";
  }
}

function bucket(access: Access, kind: ObjectKind): Map<number, GrantCapability> {
  if (kind === "proxyHost") return access.grants.proxyHosts;
  if (kind === "l4ProxyHost") return access.grants.l4ProxyHosts;
  return access.grants.agents;
}

/**
 * Without an object: held outright, which creating and every page not about one object need.
 * With one: held outright, or through a grant on it (a manage grant for write, any for read).
 */
export function can(access: Access, capability: Capability, object?: ObjectRef): boolean {
  if (holds(access.capabilities, capability)) return true;
  if (!object || !reaches(access.capabilities, capability)) return false;
  const [resource, level] = splitCapability(capability);
  if (resourceOfKind(object.kind) !== resource) return false;
  const grant = bucket(access, object.kind).get(object.id);
  return level === "read" ? grant !== undefined : grant === "manage";
}

/** Held over at least one object: opens a list page, whose rows `visibleIds` then filters. */
export function canReach(access: Access, capability: Capability): boolean {
  return reaches(access.capabilities, capability);
}

export function assertCan(access: Access, capability: Capability, object?: ObjectRef): void {
  if (!can(access, capability, object)) throw new ForbiddenError();
}

export async function resolveAccess(session: Session): Promise<Access> {
  return await accessFor(Number(session.user.id), session.user.role, session.viewAs?.groupIds);
}

/** For a caller with an id and a role but no session, e.g. a GraphQL Bearer token. */
export async function accessFor(
  userId: number,
  role: string,
  /** An admin viewing as these groups: theirs, not what the admin's memberships carry. */
  viewAsGroupIds?: number[],
): Promise<Access> {
  const own = capabilitySetOf(await roleDefinitions([role]));
  // Holding everything outright, nothing a group adds or grants could change an answer.
  if (CAPABILITIES.every((capability) => holds(own, capability))) {
    return { userId, role, capabilities: own, grants: emptyGrants() };
  }
  const groupIds = viewAsGroupIds ?? (await groupIdsOf(userId));
  const groupRoles = await rolesOfGroups(groupIds);
  const capabilities =
    groupRoles.length === 0 ? own : capabilitySetOf(await roleDefinitions([role, ...groupRoles]));
  // A backup carries every secret and account, and restoring one replaces them: it is anyone's
  // whole power, so only a caller holding everything may take or restore one.
  if (!CAPABILITIES.every((capability) => holds(capabilities, capability))) {
    delete capabilities["backups:write"];
  }
  const scoped = Object.values(capabilities).includes("granted");
  const grants = scoped ? await grantsForGroups(groupIds) : emptyGrants();
  return { userId, role, capabilities, grants };
}

/** Background work done for nobody in particular, which sees everything. */
export function systemAccess(): Access {
  return {
    userId: 0,
    role: "admin",
    capabilities: capabilitySetOf([BUILT_IN_ROLES.admin]),
    grants: emptyGrants(),
  };
}

/** A manage grant implies view. */
export function canView(access: Access, kind: ObjectKind, id: number): boolean {
  return can(access, `${resourceOfKind(kind)}:read`, { kind, id });
}

export function canManage(access: Access, kind: ObjectKind, id: number): boolean {
  return can(access, `${resourceOfKind(kind)}:write`, { kind, id });
}

/** A grant names an object that already exists, so it has nothing to say about a new one. */
export function canCreate(access: Access, kind: ObjectKind): boolean {
  return can(access, `${resourceOfKind(kind)}:write`);
}

export function visibleIds(access: Access, kind: ObjectKind, ids: number[]): number[] {
  const filter = visibleIdFilter(access, kind);
  return filter === null ? ids : ids.filter((id) => filter.has(id));
}

/** Null means no restriction. */
export function visibleIdFilter(access: Access, kind: ObjectKind): Set<number> | null {
  const capability: Capability = `${resourceOfKind(kind)}:read`;
  if (holds(access.capabilities, capability)) return null;
  if (!reaches(access.capabilities, capability)) return new Set();
  return new Set(bucket(access, kind).keys());
}

export function assertCanManage(access: Access, kind: ObjectKind, id: number): void {
  if (canManage(access, kind, id)) return;
  throw new ForbiddenError();
}

export function assertCanView(access: Access, kind: ObjectKind, id: number): void {
  if (canView(access, kind, id)) return;
  throw new ForbiddenError();
}

/** Once per page render, like the session it is resolved from. */
export async function currentAccess(): Promise<{ session: Session; access: Access }> {
  const { requireUser } = await import("../auth");
  const session = await requireUser();
  const access = await requestMemo("auth:access", () => resolveAccess(session));
  return { session, access };
}

/** The signed-in caller, if they hold `capability` outright. */
export async function requireCan(capability: Capability): Promise<Session> {
  return (await requireCanAccess(capability)).session;
}

/** As `requireCan`, with the caller's access for the checks that follow. */
export async function requireCanAccess(
  capability: Capability,
): Promise<{ session: Session; access: Access }> {
  const current = await currentAccess();
  assertCan(current.access, capability);
  return current;
}

/**
 * For a page listing objects: the caller holds `capability` over at least one. The page filters
 * its rows, and an empty page explains itself where a refusal would not.
 */
export async function requireReach(capability: Capability): Promise<Access> {
  const { access } = await currentAccess();
  if (!canReach(access, capability)) throw new ForbiddenError();
  return access;
}

/** For a model given only the acting user's id, e.g. a host write that may need more than hosts. */
export async function actorCan(actorUserId: number, capability: Capability): Promise<boolean> {
  const { getUserById } = await import("../models/user");
  const actor = await getUserById(actorUserId);
  if (!actor) return false;
  return can(await accessFor(actor.id, actor.role), capability);
}

/** For a route that reads the session itself, where a missing one is an answer, not a redirect. */
export async function sessionCan(
  session: Session | null,
  capability: Capability,
): Promise<boolean> {
  if (!session?.user) return false;
  return can(await resolveAccess(session), capability);
}
