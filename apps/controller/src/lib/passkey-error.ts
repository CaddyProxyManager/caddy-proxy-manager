/**
 * What a passkey form says when a ceremony fails, keyed on the code: the plugin's and the WebAuthn
 * library's messages are English. Null means the person cancelled, which needs no message.
 */

/** Refusals raised by auth-server.ts, whose `message` is already translated. */
export const TRANSLATED_PASSKEY_CODES = new Set([
  "PASSKEYS_DISABLED",
  "PASSKEY_NAME_TOO_LONG",
  "SESSION_NOT_FRESH",
  "LAST_SIGN_IN_METHOD",
  "USER_NOT_VERIFIED",
]);

/** The browser's prompt was dismissed or timed out, or another ceremony replaced this one. */
const CANCELLED = new Set(["AUTH_CANCELLED", "ERROR_CEREMONY_ABORTED", "REGISTRATION_CANCELLED"]);

export type PasskeyErrorKey =
  | "passkeyUnknown"
  | "passkeyAlreadyRegistered"
  | "passkeyTooManyAttempts"
  | "passkeySignInFailed"
  | "passkeyAddFailed";

export type PasskeyErrorMessage = { message: string } | { key: PasskeyErrorKey } | null;

export function passkeyError(
  error: { status?: number; code?: string; message?: string },
  ceremony: "signIn" | "register",
): PasskeyErrorMessage {
  const code = error.code ?? "";
  if (CANCELLED.has(code)) return null;
  if (TRANSLATED_PASSKEY_CODES.has(code) && error.message) return { message: error.message };
  if (error.status === 429) return { key: "passkeyTooManyAttempts" };
  if (code === "PASSKEY_NOT_FOUND" && ceremony === "signIn") return { key: "passkeyUnknown" };
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    return { key: "passkeyAlreadyRegistered" };
  }
  return { key: ceremony === "signIn" ? "passkeySignInFailed" : "passkeyAddFailed" };
}
