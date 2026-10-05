/**
 * Passkeys (@better-auth/passkey): the relying party they are bound to. Passwordless with user
 * verification, so a passkey is both factors on its own. No database here, so tests and client
 * code can import it.
 */

/** Longer names are refused, so the Profile list and the audit log stay readable. */
export const PASSKEY_NAME_MAX_LENGTH = 64;

/** The Public URL's hostname, as the plugin would derive it; null for an unparseable URL. */
export function passkeyRpId(baseURL: string): string | null {
  try {
    return new URL(baseURL).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The origins a ceremony may come from: the public ones on the rpID or a subdomain of it, which is
 * all a browser would sign for. Left to the plugin, any request's Origin header would be accepted.
 */
export function passkeyOrigins(rpId: string, origins: readonly string[]): string[] {
  return origins.filter((origin) => {
    try {
      const { hostname } = new URL(origin);
      return hostname === rpId || hostname.endsWith(`.${rpId}`);
    } catch {
      return false;
    }
  });
}

/** The plugin verifies with `requireUserVerification: false`; the UV flag is checked here. */
export function isUserVerified(
  verification:
    | { authenticationInfo?: { userVerified?: boolean } }
    | { registrationInfo?: { userVerified?: boolean } },
): boolean {
  if ("authenticationInfo" in verification) {
    return verification.authenticationInfo?.userVerified === true;
  }
  if ("registrationInfo" in verification) {
    return verification.registrationInfo?.userVerified === true;
  }
  return false;
}
