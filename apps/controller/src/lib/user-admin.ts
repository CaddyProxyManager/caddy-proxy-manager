/**
 * Account rules shared by the Users actions, `/api/v1/users` and GraphQL, so no path can write an
 * unchecked string into the role column.
 */

import { domainError, domainErrorMessage } from "./domain-error";
import { LOGIN_USERNAME_MAX_LENGTH, LOGIN_USERNAME_MIN_LENGTH } from "./login-username";
import { isEmailAddress } from "./email-address";
import { APP_ROLES, type AppRole } from "./oidc-groups";
import { isPasswordAcceptable, MIN_PASSWORD_LENGTH } from "./password-policy";

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
    | "cannotResetOwnTwoFactor",
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
