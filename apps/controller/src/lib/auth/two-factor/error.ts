/**
 * What the sign-in form says when a code is refused, keyed on the two-factor plugin's error code
 * rather than its English message. `restart` means the challenge itself is gone and the password
 * has to be entered again.
 */
export type TwoFactorErrorKey =
  | "invalidSecondFactor"
  | "secondFactorExpired"
  | "secondFactorLocked"
  | "tooManyLoginAttempts";

export function twoFactorError(error: { status?: number; code?: string }): {
  key: TwoFactorErrorKey;
  restart: boolean;
} {
  switch (error.code) {
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return { key: "secondFactorLocked", restart: true };
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
    case "INVALID_TWO_FACTOR_COOKIE":
    // The portal's own expiry, from /api/forward-auth/login/verify.
    case "CHALLENGE_EXPIRED":
      return { key: "secondFactorExpired", restart: true };
  }
  if (error.status === 429) return { key: "tooManyLoginAttempts", restart: false };
  return { key: "invalidSecondFactor", restart: false };
}
