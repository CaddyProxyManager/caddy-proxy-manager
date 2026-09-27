/** Relative to Better Auth's base path. Shared so the session hook doesn't audit them early. */
export const CREDENTIAL_SIGN_IN_PATHS = ["/sign-in/username", "/sign-in/email"] as const;

/** Where a second factor is checked after a password sign-in asked for one. */
export const TWO_FACTOR_VERIFY_PATHS = [
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
] as const;

/** Where a signed-in user turns 2FA on or off, or replaces their backup codes. */
export const TWO_FACTOR_MANAGE_PATHS = [
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
] as const;

export function isCredentialSignInPath(path: string | undefined): boolean {
  return (CREDENTIAL_SIGN_IN_PATHS as readonly string[]).includes(path ?? "");
}

export function isTwoFactorVerifyPath(path: string | undefined): boolean {
  return (TWO_FACTOR_VERIFY_PATHS as readonly string[]).includes(path ?? "");
}

/** Only a sign-in part-way through has it; enabling 2FA hits the same verify endpoint without. */
export function hasTwoFactorChallengeCookie(cookieHeader: string | null | undefined): boolean {
  return /(?:^|;\s*)(?:__Secure-)?[^=;]*\.two_factor=/.test(cookieHeader ?? "");
}
