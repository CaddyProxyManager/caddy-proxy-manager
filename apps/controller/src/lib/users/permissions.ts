/**
 * Grants reach only `operator`, whose baseline is nothing. `admin` ignores them, so no arrangement
 * of groups leaves an instance nobody can administer; `user` and `viewer` manage nothing.
 */

import type { Session } from "../auth";
import { requestMemo } from "../request-memo";
import { DomainError, domainErrorMessage } from "../errors/domain-error";
import {
  type EffectiveGrants,
  type GrantCapability,
  emptyGrants,
  grantsForGroups,
  grantsForUser,
} from "../models/group-grants";

export type ResourceKind = "proxyHost" | "l4ProxyHost" | "agent";

/** What the current viewer may do, resolved once per request. */
export type Access = {
  userId: number;
  role: string;
  isAdmin: boolean;
  /** The only role grants apply to. */
  isOperator: boolean;
  grants: EffectiveGrants;
};

/** A `DomainError`, so an action says it in the reader's language. */
export class ForbiddenError extends DomainError {
  constructor() {
    super("accessDenied", {}, domainErrorMessage("accessDenied"));
    this.name = "ForbiddenError";
  }
}

function bucket(access: Access, kind: ResourceKind): Map<number, GrantCapability> {
  if (kind === "proxyHost") return access.grants.proxyHosts;
  if (kind === "l4ProxyHost") return access.grants.l4ProxyHosts;
  return access.grants.agents;
}

export async function resolveAccess(session: Session): Promise<Access> {
  return await accessFor(Number(session.user.id), session.user.role, session.viewAs?.groupIds);
}

/** For a caller with an id and a role but no session, e.g. a GraphQL Bearer token. */
export async function accessFor(
  userId: number,
  role: string,
  /** An admin viewing as these groups: their grants, not the ones the admin's memberships carry. */
  viewAsGroupIds?: number[],
): Promise<Access> {
  const isOperator = role === "operator";
  const grants = !isOperator
    ? emptyGrants()
    : viewAsGroupIds
      ? await grantsForGroups(viewAsGroupIds)
      : await grantsForUser(userId);

  return { userId, role, isAdmin: role === "admin", isOperator, grants };
}

/** A manage grant implies view. */
export function canView(access: Access, kind: ResourceKind, id: number): boolean {
  if (access.isAdmin) return true;
  if (!access.isOperator) return false;
  return bucket(access, kind).has(id);
}

export function canManage(access: Access, kind: ResourceKind, id: number): boolean {
  if (access.isAdmin) return true;
  if (!access.isOperator) return false;
  return bucket(access, kind).get(id) === "manage";
}

/**
 * Creating, or anything not tied to a resource. Admins only: a grant names a resource that
 * already exists, so it has nothing to say about one that does not.
 */
export function canCreate(access: Access): boolean {
  return access.isAdmin;
}

export function visibleIds(access: Access, kind: ResourceKind, ids: number[]): number[] {
  if (access.isAdmin) return ids;
  if (!access.isOperator) return [];
  const granted = bucket(access, kind);
  return ids.filter((id) => granted.has(id));
}

/** Null means no restriction (an admin). */
export function visibleIdFilter(access: Access, kind: ResourceKind): Set<number> | null {
  if (access.isAdmin) return null;
  if (!access.isOperator) return new Set();
  return new Set(bucket(access, kind).keys());
}

export function assertCanManage(access: Access, kind: ResourceKind, id: number): void {
  if (canManage(access, kind, id)) return;
  throw new ForbiddenError();
}

export function assertCanView(access: Access, kind: ResourceKind, id: number): void {
  if (canView(access, kind, id)) return;
  throw new ForbiddenError();
}

/** Once per page render, like the session it is resolved from. */
export async function requireAccess(): Promise<Access> {
  const { requireManager } = await import("../auth");
  const session = await requireManager();
  return requestMemo("auth:access", () => resolveAccess(session));
}

/** Gates navigation. An operator with no grants still gets the pages, empty, not a redirect. */
export function hasManagementSurface(role: string | undefined): boolean {
  return role === "admin" || role === "operator";
}
