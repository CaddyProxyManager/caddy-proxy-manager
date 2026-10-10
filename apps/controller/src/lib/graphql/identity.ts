/**
 * Accounts, their sessions and forward-auth over GraphQL: the same model calls and guards as
 * `/api/v1/users`, `/api/v1/sessions`, `/api/v1/forward-auth-sessions` and
 * `/api/v1/proxy-hosts/{id}/forward-auth-access`.
 */

import { ApiAuthError, NotFoundError, ROLE_REFUSED } from "../api/auth";
import { ApiValidationError } from "../api/errors";
import { apiSubmitter, submitOrApply } from "../approvals";
import { getCurrentSessionId } from "../auth";
import { LOGIN_USERNAME_MAX_LENGTH, LOGIN_USERNAME_MIN_LENGTH } from "../auth/login-username";
import { hashPassword } from "../auth/password";
import { localUsersDisabled } from "../auth/policy";
import { domainError } from "../errors/domain-error";
import {
  deleteForwardAuthSession,
  getForwardAuthAccessForHost,
  listForwardAuthSessions,
} from "../models/forward-auth";
import { getProxyHost } from "../models/proxy-hosts";
import { listUserSessions, revokeUserSession } from "../models/sessions";
import { type User, createUser } from "../models/user";
import { isKnownRole } from "../roles/store";
import { can } from "../users/permissions";
import { assertAcceptablePassword, assertAssignableRole, assertEmailAddress } from "../users/admin";
import type { GraphQLContext } from "./context";

/** The row carries a password hash and the OAuth subject. */
export function projectUser(row: User) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    provider: row.provider,
    avatarUrl: row.avatarUrl,
    lastSignInAt: row.lastSignInAt,
    lastSignInMethod: row.lastSignInMethod,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireProxyHost(id: number): Promise<void> {
  if (!(await getProxyHost(id))) throw new NotFoundError("Proxy host not found");
}

function isIdList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((id) => Number.isInteger(id) && (id as number) > 0);
}

/** REST takes the body as is; a non-list would fail inside the model as an internal error. */
function parseAccessInput(input: unknown): { userIds?: number[]; groupIds?: number[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiValidationError("input must be an object with userIds and groupIds");
  }
  const { userIds, groupIds } = input as Record<string, unknown>;
  if (userIds !== undefined && !isIdList(userIds)) {
    throw new ApiValidationError("userIds must be a list of user ids");
  }
  if (groupIds !== undefined && !isIdList(groupIds)) {
    throw new ApiValidationError("groupIds must be a list of group ids");
  }
  return { userIds, groupIds };
}

export const identityQueryResolvers = {
  sessions: async (_: unknown, args: { userId?: number | null }, context: GraphQLContext) => {
    const viewer = await context.viewer();
    const userId = args.userId ?? viewer.userId;
    // One's own sessions, as over REST; someone else's only with the users capability.
    if (userId !== viewer.userId && !can(await context.access(), "users:read")) {
      throw new ApiAuthError(ROLE_REFUSED, 403);
    }
    const list = await listUserSessions(userId);
    // Only a session request has a current session, and only among its own.
    const currentId =
      userId === viewer.userId && viewer.authMethod === "session"
        ? await getCurrentSessionId(context.request)
        : null;
    return list.map((session) => ({ ...session, current: session.id === currentId }));
  },
  forwardAuthSessions: async (_: unknown, args: { userId?: number | null }) => {
    const list = await listForwardAuthSessions();
    return args.userId == null ? list : list.filter((s) => s.userId === args.userId);
  },
  forwardAuthAccess: async (_: unknown, args: { proxyHostId: number }) => {
    await requireProxyHost(args.proxyHostId);
    return await getForwardAuthAccessForHost(args.proxyHostId);
  },
};

export const identityMutationResolvers = {
  createUser: async (
    _: unknown,
    args: { input: Record<string, unknown> },
    context: GraphQLContext,
  ) => {
    const { capabilities } = await context.access();
    if (await localUsersDisabled()) throw domainError("localUserCreationDisabled");

    const body = args.input ?? {};
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    const name = body.name ? String(body.name).trim() : null;
    const requested = body.role === undefined || body.role === null ? "user" : body.role;
    if (!(await isKnownRole(requested))) throw domainError("invalidUserRole");
    const role = await assertAssignableRole(capabilities, requested);
    // Optional: without one, createUser gives their own email when it can be a username.
    const username: unknown = body.username ?? null;
    if (username !== null && typeof username !== "string") {
      throw domainError("signInUsernameInvalid", {
        min: LOGIN_USERNAME_MIN_LENGTH,
        max: LOGIN_USERNAME_MAX_LENGTH,
      });
    }
    if (!email || !password) throw domainError("emailAndPasswordRequired");
    assertEmailAddress(email);
    assertAcceptablePassword(password);

    const user = await createUser({
      email,
      name,
      role,
      provider: "credentials",
      subject: email,
      passwordHash: await hashPassword(password),
      username,
    });
    return projectUser(user);
  },
  revokeSession: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    // The owner's alone: the predicate answers "not found" for anyone else's, as REST does.
    if (!(await revokeUserSession(userId, args.id))) {
      throw new NotFoundError("Session not found");
    }
    return true;
  },
  revokeForwardAuthSession: async (_: unknown, args: { id: number }) => {
    await deleteForwardAuthSession(args.id);
    return true;
  },
  setForwardAuthAccess: async (
    _: unknown,
    args: { proxyHostId: number; input: unknown },
    context: GraphQLContext,
  ) => {
    await requireProxyHost(args.proxyHostId);
    const access = parseAccessInput(args.input);
    return await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "forwardAuthAccess",
      payload: {
        hostId: args.proxyHostId,
        access: { userIds: access.userIds ?? [], groupIds: access.groupIds ?? [] },
      },
    });
  },
};
