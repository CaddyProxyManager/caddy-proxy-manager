/**
 * From a directory's "yes" to a CPM user, shared by `/sign-in/ldap` and the forward-auth portal.
 * An identity is found by directory + stable id only; the one other way to an existing account is
 * the directory's own `mail` with "Link accounts by email" on, which an administrator chose.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { InternalAdapter } from "@better-auth/core";
import db from "../db";
import { accounts, users } from "../db/schema";
import {
  mapGroupsToLocalGroups,
  mapGroupsToRole,
  needsGroupClaims,
  toGroupMappingConfig,
} from "../auth/oidc/groups";
import { applyOidcSync } from "../services/oidc-group-sync";
import {
  type LdapDirectory,
  getLdapDirectory,
  listEnabledLdapDirectories,
} from "../models/ldap-directories";
import { type LdapIdentity, authenticateLdap } from "./client";

/** The one enabled directory when none is named; with several, the form must say which. */
export async function resolveSignInDirectory(
  directoryId: string | null | undefined,
): Promise<LdapDirectory | null> {
  if (directoryId) {
    const directory = await getLdapDirectory(directoryId);
    return directory?.enabled ? directory : null;
  }
  const enabled = await listEnabledLdapDirectories();
  return enabled.length === 1 ? enabled[0] : null;
}

/**
 * A made-up address for an entry without `mail`: `users.email` is required and unique. The hash
 * keeps two names that sanitize alike apart; `.invalid` can never be delivered to or registered.
 */
export function placeholderEmail(
  directory: LdapDirectory,
  identity: LdapIdentity,
  username: string,
) {
  const local =
    username
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 48) || "user";
  const hash = createHash("sha256").update(identity.accountId).digest("hex").slice(0, 8);
  return `${local}.${hash}@${directory.id.slice(0, 8)}.ldap.invalid`;
}

async function linkedUserId(directory: LdapDirectory, accountId: string): Promise<number | null> {
  const [row] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.providerId, directory.id), eq(accounts.accountId, accountId)))
    .limit(1);
  return row?.userId ?? null;
}

async function userIdByEmail(email: string): Promise<number | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return row?.id ?? null;
}

async function hasAccountFor(userId: number, directory: LdapDirectory): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, directory.id)))
    .limit(1);
  return !!row;
}

export type LdapUserResolution =
  | { ok: true; userId: number; created: boolean }
  | {
      ok: false;
      reason: "email-in-use" | "registration-closed" | "already-linked" | "create-failed";
    };

/** The CPM user for a directory identity: linked already, linked now by email, or created. */
export async function resolveLdapUser(
  adapter: InternalAdapter,
  directory: LdapDirectory,
  identity: LdapIdentity,
  username: string,
  allowRegistration: boolean,
): Promise<LdapUserResolution> {
  const linked = await linkedUserId(directory, identity.accountId);
  if (linked !== null) return { ok: true, userId: linked, created: false };

  const existing = identity.email ? await userIdByEmail(identity.email) : null;
  if (existing !== null) {
    if (!directory.autoLink) return { ok: false, reason: "email-in-use" };
    // One entry per directory per user: a second would be a different person with that address.
    if (await hasAccountFor(existing, directory)) return { ok: false, reason: "already-linked" };
    await adapter.createAccount({
      userId: String(existing),
      providerId: directory.id,
      accountId: identity.accountId,
    });
    return { ok: true, userId: existing, created: false };
  }

  if (!allowRegistration) return { ok: false, reason: "registration-closed" };
  try {
    const { user } = await adapter.createOAuthUser(
      {
        email: (identity.email ?? placeholderEmail(directory, identity, username)).toLowerCase(),
        name: identity.name ?? username,
        // Never trusted as proof of the address: only autoLink above decides that.
        emailVerified: false,
      },
      { providerId: directory.id, accountId: identity.accountId },
    );
    return { ok: true, userId: Number(user.id), created: true };
  } catch (error) {
    console.warn(`[ldap] ${directory.name}: could not create a user for ${identity.dn}:`, error);
    return { ok: false, reason: "create-failed" };
  }
}

/** The directory's groups onto the user's role and CPM groups, as a group claim would be. */
export async function applyLdapGroups(
  userId: number,
  directory: LdapDirectory,
  identity: LdapIdentity,
): Promise<void> {
  const mapping = toGroupMappingConfig(directory);
  if (!needsGroupClaims(mapping)) return;
  await applyOidcSync(userId, {
    providerId: directory.id,
    subject: identity.accountId,
    providerName: directory.name,
    role: mapGroupsToRole(identity.groups, mapping),
    localGroups: mapGroupsToLocalGroups(identity.groups, mapping),
    claimedGroups: identity.groups,
    syncGroups: mapping.syncGroups,
  });
}

/**
 * Authenticates against one directory and returns the CPM user id, applying group mapping first
 * so the role is in effect before any session exists. Null for every kind of refusal.
 */
export async function signInWithDirectory(
  adapter: InternalAdapter,
  directory: LdapDirectory,
  username: string,
  password: string,
  allowRegistration: boolean,
): Promise<number | null> {
  const result = await authenticateLdap(directory, username, password);
  if (!result.ok) return null;
  const resolved = await resolveLdapUser(
    adapter,
    directory,
    result.identity,
    username,
    allowRegistration,
  );
  if (!resolved.ok) {
    console.warn(`[ldap] ${directory.name}: refused ${result.identity.dn} (${resolved.reason})`);
    return null;
  }
  try {
    await applyLdapGroups(resolved.userId, directory, result.identity);
  } catch (error) {
    // As for OIDC: a failed sync keeps the role the user had rather than refusing the sign-in.
    console.warn(`[ldap] ${directory.name}: group sync failed:`, error);
  }
  return resolved.userId;
}
