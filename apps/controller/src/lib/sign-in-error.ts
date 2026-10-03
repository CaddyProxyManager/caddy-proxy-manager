/**
 * Maps Better Auth's `code` (its `message` is always English) to the catalog; unknown codes get a
 * generic sentence, and the codeless 429 matches by status. `auth.errors` keeps Better Auth's
 * English wording, which `tests/unit/sign-in-error.test.ts` pins.
 */

export type SignInErrorKey =
  | "emailNotVerified"
  | "invalidUsername"
  | "invalidUsernameOrPassword"
  | "tooManyRequests"
  | "unknown"
  | "usernameTooLong"
  | "usernameTooShort";

/** From the username plugin's USERNAME_ERROR_CODES. */
export const SIGN_IN_ERROR_KEYS: Readonly<
  Record<string, Exclude<SignInErrorKey, "tooManyRequests" | "unknown">>
> = {
  INVALID_USERNAME_OR_PASSWORD: "invalidUsernameOrPassword",
  INVALID_USERNAME: "invalidUsername",
  USERNAME_TOO_SHORT: "usernameTooShort",
  USERNAME_TOO_LONG: "usernameTooLong",
  EMAIL_NOT_VERIFIED: "emailNotVerified",
};

import type { useFormatter } from "next-intl";

/** A per-account lock, told apart from Better Auth's per-address limit, which has no code. */
export const ACCOUNT_LOCKED = "ACCOUNT_LOCKED";

/** Seconds until an account lock lifts, from the refusal's `retryAfter`; null for anything else. */
export function accountLockSeconds(error: {
  status?: number;
  code?: string;
  retryAfter?: unknown;
}): number | null {
  if (error.status !== 429 || error.code !== ACCOUNT_LOCKED) return null;
  const seconds = Number(error.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/** "in 8 seconds", in the reader's language: the lock's end as the form tells it. */
export function lockLiftsIn(format: ReturnType<typeof useFormatter>, seconds: number): string {
  const now = new Date();
  return format.relativeTime(new Date(now.getTime() + seconds * 1000), now);
}

export function signInErrorMessage(
  error: { status?: number; code?: string },
  t: (key: SignInErrorKey) => string,
): string {
  if (error.status === 429) return t("tooManyRequests");
  // Own properties only: a code of "toString" must not find Object.prototype's.
  const key =
    error.code && Object.hasOwn(SIGN_IN_ERROR_KEYS, error.code)
      ? SIGN_IN_ERROR_KEYS[error.code]
      : undefined;
  return t(key ?? "unknown");
}
