/** A directory's username and password (lib/ldap/plugin.ts). */
export const LDAP_SIGN_IN_PATH = "/sign-in/ldap";

/**
 * Relative to Better Auth's base path. Shared so the session hook doesn't audit them early, and
 * so the route throttles and CAPTCHAs each: a directory password is guessed like any other.
 */
export const CREDENTIAL_SIGN_IN_PATHS = [
  "/sign-in/username",
  "/sign-in/email",
  LDAP_SIGN_IN_PATH,
] as const;

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

/** Passwordless: a passkey sign-in skips the password path's 2FA step, CAPTCHA and throttle. */
export const PASSKEY_SIGN_IN_PATHS = [
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
] as const;

/** Adding a passkey is a new way in, so it needs a sign-in minutes old (`isFreshSession`). */
export const PASSKEY_REGISTER_PATHS = [
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
] as const;

/** Every passkey route that changes the signed-in user's credentials. */
export const PASSKEY_MANAGE_PATHS = [
  ...PASSKEY_REGISTER_PATHS,
  "/passkey/update-passkey",
  "/passkey/delete-passkey",
] as const;

export function isPasskeySignInPath(path: string | undefined): boolean {
  return (PASSKEY_SIGN_IN_PATHS as readonly string[]).includes(path ?? "");
}

export function isPasskeyRegisterPath(path: string | undefined): boolean {
  return (PASSKEY_REGISTER_PATHS as readonly string[]).includes(path ?? "");
}
