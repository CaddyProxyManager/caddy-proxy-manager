/**
 * Which account a sign-in name reaches. The login page finds an account by username; the
 * forward-auth portal reads a typed name as the email `<name>@localhost`. So a username is never
 * another account's username, email or portal name, and an email is never another account's
 * username (nor, for @localhost, the part before it). Compared lowercased, as Better Auth types it.
 *
 * Server only: the page-safe rules are in login-username.ts.
 */
import { and, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db";
import { users } from "./db/schema";
import type { DomainErrorCode } from "./domain-error";
import { isUsableSignInUsername, isValidLoginUsername } from "./login-username";

export type SignInNameReader = Pick<Db, "select">;

export const PORTAL_EMAIL_DOMAIN = "@localhost";

function otherThan(userId: number | null) {
  return userId === null ? undefined : ne(users.id, userId);
}

async function anyUser(reader: SignInNameReader, where: ReturnType<typeof and>): Promise<boolean> {
  const rows = await reader.select({ id: users.id }).from(users).where(where).limit(1);
  return rows.length > 0;
}

/** Whether an account but `userId` has `name` (lowercase) as username, email or portal name. */
export function isSignInNameTaken(
  reader: SignInNameReader,
  userId: number | null,
  name: string,
): Promise<boolean> {
  return anyUser(
    reader,
    and(
      or(
        sql`lower(${users.username}) = ${name}`,
        sql`lower(${users.email}) = ${name}`,
        sql`lower(${users.email}) = ${name + PORTAL_EMAIL_DOMAIN}`,
      ),
      otherThan(userId),
    ),
  );
}

/** Why account `userId` (null: not created yet) cannot have `email`, or null when it can. */
export async function signInEmailConflict(
  reader: SignInNameReader,
  userId: number | null,
  email: string,
): Promise<DomainErrorCode | null> {
  const address = email.trim().toLowerCase();
  if (await anyUser(reader, and(sql`lower(${users.email}) = ${address}`, otherThan(userId)))) {
    return "emailTaken";
  }
  if (await anyUser(reader, and(sql`lower(${users.username}) = ${address}`, otherThan(userId)))) {
    return "emailIsAnotherUsername";
  }
  if (address.endsWith(PORTAL_EMAIL_DOMAIN)) {
    const portalName = address.slice(0, -PORTAL_EMAIL_DOMAIN.length);
    if (
      await anyUser(reader, and(sql`lower(${users.username}) = ${portalName}`, otherThan(userId)))
    ) {
      return "emailPortalNameIsAnotherUsername";
    }
  }
  return null;
}

/** Lowercasing the Kelvin sign gives 'k': the stored address would be someone else's. */
export function lowercasesIntoAscii(value: string): boolean {
  return [...value].some(
    (char) =>
      (char.codePointAt(0) ?? 0) > 0x7f &&
      [...char.toLowerCase()].some((lowered) => (lowered.codePointAt(0) ?? 0) <= 0x7f),
  );
}

/**
 * The only username CPM gives by itself: the account's own email lowercased, when the login page
 * can use it and nobody else holds it. Null otherwise, until an administrator sets one.
 */
export async function ownEmailUsername(
  reader: SignInNameReader,
  userId: number | null,
  email: string,
): Promise<string | null> {
  // Checked before lowercasing, so only A-Z change (see lowercasesIntoAscii).
  if (!isValidLoginUsername(email)) return null;
  const username = email.toLowerCase();
  if (!isUsableSignInUsername(username)) return null;
  return (await isSignInNameTaken(reader, userId, username)) ? null : username;
}
