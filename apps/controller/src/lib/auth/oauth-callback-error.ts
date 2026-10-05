/**
 * Better Auth's OAuth `?error=` as a sign-in page sentence. Only `account_not_linked`, the one an
 * operator can act on (sign in another way, link from Profile), gets its own wording. A code is
 * echoed only when it looks like Better Auth's, so a crafted link cannot put text on the page.
 */

type Translate = (
  key: "accountNotLinked" | "oauthFailedCode",
  values?: Record<string, string>,
) => string;

const CODE_SHAPE = /^[a-z_]{1,64}$/;

export function oauthCallbackErrorMessage(code: string | undefined, t: Translate): string | null {
  if (!code) return null;
  if (code === "account_not_linked") return t("accountNotLinked");
  return t("oauthFailedCode", { code: CODE_SHAPE.test(code) ? code : "unknown" });
}
