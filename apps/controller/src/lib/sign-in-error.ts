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
