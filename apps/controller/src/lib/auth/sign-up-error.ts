/**
 * Maps a refused sign-up to the catalog, by code as sign-in-error.ts does. The one exception is
 * the password policy: auth/server.ts words that refusal itself, in the reader's language, and
 * marks it with PASSWORD_POLICY_CODE so it is shown as sent.
 */
import { PASSWORD_POLICY_CODE } from "./signup-policy";

export type SignUpErrorKey =
  | "emailTaken"
  | "invalidEmail"
  | "passwordTooLong"
  | "signUpDisabled"
  | "signUpFailed"
  | "tooManyRequests";

/** From Better Auth's BASE_ERROR_CODES and its sign-up route. */
export const SIGN_UP_ERROR_KEYS: Readonly<
  Record<string, Exclude<SignUpErrorKey, "signUpFailed" | "tooManyRequests">>
> = {
  EMAIL_PASSWORD_SIGN_UP_DISABLED: "signUpDisabled",
  USER_ALREADY_EXISTS: "emailTaken",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "emailTaken",
  INVALID_EMAIL: "invalidEmail",
  PASSWORD_TOO_LONG: "passwordTooLong",
};

export function signUpErrorMessage(
  error: { status?: number; code?: string; message?: string },
  t: (key: SignUpErrorKey) => string,
): string {
  if (error.code === PASSWORD_POLICY_CODE && error.message) return error.message;
  if (error.status === 429) return t("tooManyRequests");
  // Own properties only: a code of "toString" must not find Object.prototype's.
  const key =
    error.code && Object.hasOwn(SIGN_UP_ERROR_KEYS, error.code)
      ? SIGN_UP_ERROR_KEYS[error.code]
      : undefined;
  return t(key ?? "signUpFailed");
}
