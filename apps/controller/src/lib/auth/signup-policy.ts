import { passwordPolicyMessage } from "./password/policy-message";

type Translate = Parameters<typeof passwordPolicyMessage>[0];

/** The one Better Auth route the password policy is applied to by hand. */
export const SIGN_UP_EMAIL_PATH = "/sign-up/email";

/** On the refusal: its message is already in the reader's language, so the form shows it as is. */
export const PASSWORD_POLICY_CODE = "PASSWORD_POLICY";

/**
 * Null lets it through. Better Auth's own sign-up would only check its length floor. Pure, so it
 * is testable without an auth instance.
 */
export function signUpPasswordError(path: string, body: unknown, t: Translate): string | null {
  if (path !== SIGN_UP_EMAIL_PATH) return null;
  const password = (body as { password?: unknown } | null | undefined)?.password;
  return passwordPolicyMessage(
    t,
    typeof password === "string" ? password : "",
    t("passwordPolicy.subject.password" as Parameters<Translate>[0]),
  );
}
