/**
 * Account rules shared by the Users actions, `/api/v1/users` and GraphQL, so no path can write an
 * unchecked string into the role column.
 */

import { domainError, domainErrorMessage } from "../errors/domain-error";
import { LOGIN_USERNAME_MAX_LENGTH, LOGIN_USERNAME_MIN_LENGTH } from "../auth/login-username";
import { isEmailAddress } from "../email/address";
import { APP_ROLES, type AppRole } from "../auth/oidc/groups";
import { isPasswordAcceptable, MIN_PASSWORD_LENGTH } from "../auth/password/policy";
import { type User, getUserById } from "../models/user";
import type { CapabilitySet } from "../roles/capabilities";
import { assertMayAssignRole, assertMayManageAccount } from "../roles/store";

export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export function isUserRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

export function isUserStatus(value: unknown): value is UserStatus {
  return typeof value === "string" && (USER_STATUSES as readonly string[]).includes(value);
}

export function assertUserRole(value: unknown): AppRole {
  if (!isUserRole(value)) throw domainError("invalidUserRole");
  return value;
}

export function assertUserStatus(value: unknown): UserStatus {
  if (!isUserStatus(value)) throw domainError("invalidUserStatus");
  return value;
}

/** An administrator acting on their own account could remove the last way to administer this one. */
export function assertNotSelf(
  actorId: number,
  targetId: number,
  code:
    | "cannotChangeOwnRole"
    | "cannotChangeOwnStatus"
    | "cannotDeleteOwnAccount"
    | "cannotResetOwnTwoFactor"
    | "cannotRemoveOwnPasskeys",
): void {
  if (actorId === targetId) throw domainError(code);
}

/** Not in the model: OAuth writes what its provider asserts, and refusing would lock users out. */
export function assertEmailAddress(email: string): void {
  if (!isEmailAddress(email)) throw domainError("emailInvalid");
}

/** For a username that is not even a string, which the model never sees. */
export function signInUsernameRulesMessage(): string {
  return domainErrorMessage("signInUsernameInvalid", {
    min: LOGIN_USERNAME_MIN_LENGTH,
    max: LOGIN_USERNAME_MAX_LENGTH,
  });
}

export function assertAcceptablePassword(password: string): void {
  if (!isPasswordAcceptable(password)) {
    throw domainError("passwordDoesNotMeetPolicy", { min: MIN_PASSWORD_LENGTH });
  }
}

/**
 * A role the caller may hand out: one that exists, all of whose permissions they hold outright.
 * Built-in or made, so this replaces `assertUserRole` wherever a person picks the role.
 */
export async function assertAssignableRole(
  holding: CapabilitySet,
  value: unknown,
): Promise<string> {
  if (typeof value !== "string" || !value) throw domainError("invalidUserRole");
  return (await assertMayAssignRole(holding, value)).key;
}

/** Only someone holding at least what an account holds may act on it. Null if there is none. */
export async function assertMayManageUser(
  holding: CapabilitySet,
  userId: number,
): Promise<User | null> {
  const target = await getUserById(userId);
  if (target) await assertMayManageAccount(holding, target.role);
  return target;
}
