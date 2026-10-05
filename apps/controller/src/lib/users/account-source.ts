/**
 * Where each account came from, for the users list: made here (it has a local password), from a
 * directory, or from a single sign-on provider. A local account that linked a provider stays local.
 */
import { eq } from "drizzle-orm";
import db from "../db";
import { accounts, oauthProviders, users } from "../db/schema";
import { LDAP_PROVIDER_TYPE } from "../ldap/defaults";

export const ACCOUNT_SOURCES = ["local", "oidc", "ldap"] as const;

export type AccountSource = (typeof ACCOUNT_SOURCES)[number];

export async function accountSourcesByUser(): Promise<Map<number, AccountSource>> {
  const [rows, linked, directories] = await Promise.all([
    db.select({ id: users.id, passwordHash: users.passwordHash }).from(users),
    db.select({ userId: accounts.userId, providerId: accounts.providerId }).from(accounts),
    db
      .select({ id: oauthProviders.id })
      .from(oauthProviders)
      .where(eq(oauthProviders.type, LDAP_PROVIDER_TYPE)),
  ]);
  const directoryIds = new Set(directories.map((row) => row.id));
  const byUser = new Map<number, string[]>();
  for (const row of linked) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.providerId]);
  }

  const sources = new Map<number, AccountSource>();
  for (const user of rows) {
    const providers = byUser.get(user.id) ?? [];
    if (user.passwordHash || providers.includes("credential")) {
      sources.set(user.id, "local");
    } else if (providers.some((id) => directoryIds.has(id))) {
      sources.set(user.id, "ldap");
    } else if (providers.length > 0) {
      sources.set(user.id, "oidc");
    } else {
      sources.set(user.id, "local");
    }
  }
  return sources;
}

/** Linked accounts per provider id, for the sign-in overview. */
export async function linkedAccountCounts(): Promise<Map<string, number>> {
  const rows = await db.select({ providerId: accounts.providerId }).from(accounts);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.providerId, (counts.get(row.providerId) ?? 0) + 1);
  return counts;
}
