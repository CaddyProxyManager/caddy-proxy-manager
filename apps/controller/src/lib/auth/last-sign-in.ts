/**
 * When and how each account last signed in, for the users list. Written once a sign-in completes:
 * by the session hook for passkeys, single sign-on and a second factor, and by the auth route for a
 * password that needed no second step. Never fails the sign-in it describes.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import db, { nowIso } from "../db";
import { accounts, oauthProviders, users } from "../db/schema";
import { LDAP_PROVIDER_TYPE } from "../ldap/defaults";
import { LDAP_SIGN_IN_PATH, isPasskeySignInPath, isTwoFactorVerifyPath } from "./sign-in-paths";
import type { SignInMethod } from "./sign-in-methods";

export async function recordSignIn(userId: number, method: SignInMethod): Promise<void> {
  try {
    await db
      .update(users)
      .set({ lastSignInAt: nowIso(), lastSignInMethod: method })
      .where(eq(users.id, userId));
  } catch (error) {
    console.warn("[auth] Could not record the sign-in time:", error);
  }
}

/** A local password: on the user row for accounts made here, on the account row for sign-ups. */
async function hasLocalPassword(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNotNull(users.passwordHash)))
    .limit(1);
  if (row) return true;
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);
  return Boolean(account);
}

async function hasDirectoryAccount(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(oauthProviders, eq(oauthProviders.id, accounts.providerId))
    .where(and(eq(accounts.userId, userId), eq(oauthProviders.type, LDAP_PROVIDER_TYPE)))
    .limit(1);
  return Boolean(row);
}

/**
 * A password typed at /login: the directory's when one was picked, or when the account has no
 * password of its own to have matched; otherwise the local one, which the form tries first.
 */
export async function passwordSignInMethod(
  userId: number,
  path: string,
  directoryChosen: boolean,
): Promise<SignInMethod> {
  if (path !== LDAP_SIGN_IN_PATH) return "password";
  if (directoryChosen) return "ldap";
  return (await hasLocalPassword(userId)) ? "password" : "ldap";
}

/** For the session hook. Null where the auth route records it instead, or nothing signed in. */
export async function sessionSignInMethod(
  userId: number,
  path: string | undefined,
): Promise<SignInMethod | null> {
  if (!path) return null;
  if (isPasskeySignInPath(path)) return "passkey";
  // "oidc" is what the users list calls single sign-on, whichever protocol it came by.
  if (
    path.startsWith("/oauth2/callback/") ||
    path.startsWith("/callback/") ||
    path.startsWith("/sso/saml2/sp/acs/")
  ) {
    return "oidc";
  }
  if (path === "/sign-up/email") return "password";
  if (isTwoFactorVerifyPath(path)) {
    // The second step after a password: whose password is the account's to say.
    return !(await hasLocalPassword(userId)) && (await hasDirectoryAccount(userId))
      ? "ldap"
      : "password";
  }
  return null;
}
