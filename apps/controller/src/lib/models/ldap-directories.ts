/**
 * LDAP directories: `oauth_providers` rows with `type='ldap'`, so group mappings, `accounts` rows
 * and backups need nothing new. Every OIDC reader in oauth-providers.ts skips these rows.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { nowIso } from "../db";
import { accounts, oauthProviders, passkeys, users } from "../db/schema";
import { decryptSecret, encryptSecret } from "../secrets";
import { isAppRole } from "../auth/oidc/groups";
import { domainError } from "../errors/domain-error";
import { revokeSessionsAfterPasswordChange } from "./sessions";
import type { OAuthGroupMapping } from "./oauth-providers";
import {
  LDAP_PROVIDER_TYPE,
  type LdapConfig,
  normalizeLdapConfig,
  parseLdapConfig,
  parseLdapUrl,
  validateLdapSettings,
} from "../ldap/config";

export type LdapDirectory = OAuthGroupMapping & {
  id: string;
  name: string;
  url: string;
  /** Empty for an anonymous search, or with a user-DN template. */
  bindDn: string;
  bindPassword: string;
  config: LdapConfig;
  /** Link a first sign-in to an existing account with the directory's `mail`. */
  autoLink: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** What reaches the browser: the bind password never does. */
export type LdapDirectoryView = Omit<LdapDirectory, "bindPassword"> & { hasBindPassword: boolean };

export type LdapDirectoryInput = Partial<OAuthGroupMapping> & {
  name: string;
  url: string;
  bindDn?: string;
  /** Blank keeps the stored one on update. */
  bindPassword?: string;
  config: Partial<LdapConfig>;
  autoLink?: boolean;
  enabled?: boolean;
};

type Row = typeof oauthProviders.$inferSelect;

function parseRow(row: Row): LdapDirectory {
  return {
    id: row.id,
    name: row.name,
    url: row.issuer ?? "",
    bindDn: decryptSecret(row.clientId, `LDAP directory "${row.name}"`),
    bindPassword: decryptSecret(row.clientSecret, `LDAP directory "${row.name}"`),
    config: parseLdapConfig(row.ldapConfig),
    autoLink: row.autoLink,
    enabled: row.enabled,
    groupsClaim: row.groupsClaim,
    groupPrefix: row.groupPrefix,
    roleMappingEnabled: row.roleMappingEnabled,
    adminGroup: row.adminGroup,
    operatorGroup: row.operatorGroup,
    userGroup: row.userGroup,
    viewerGroup: row.viewerGroup,
    defaultRole: isAppRole(row.defaultRole) ? row.defaultRole : "user",
    syncGroups: row.syncGroups,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toLdapDirectoryView(directory: LdapDirectory): LdapDirectoryView {
  const { bindPassword, ...rest } = directory;
  return { ...rest, hasBindPassword: bindPassword.length > 0 };
}

const isLdap = eq(oauthProviders.type, LDAP_PROVIDER_TYPE);

export async function listLdapDirectories(): Promise<LdapDirectoryView[]> {
  const rows = await db.select().from(oauthProviders).where(isLdap).orderBy(oauthProviders.name);
  return rows.map((row) => toLdapDirectoryView(parseRow(row)));
}

/** With credentials, for signing in. */
export async function listEnabledLdapDirectories(): Promise<LdapDirectory[]> {
  const rows = await db
    .select()
    .from(oauthProviders)
    .where(and(isLdap, eq(oauthProviders.enabled, true)))
    .orderBy(oauthProviders.name);
  return rows.map(parseRow);
}

/** For the sign-in forms: names only. */
export async function listLdapDirectoryChoices(): Promise<Array<{ id: string; name: string }>> {
  return (await listEnabledLdapDirectories()).map(({ id, name }) => ({ id, name }));
}

export async function getLdapDirectory(id: string): Promise<LdapDirectory | null> {
  const [row] = await db
    .select()
    .from(oauthProviders)
    .where(and(isLdap, eq(oauthProviders.id, id)))
    .limit(1);
  return row ? parseRow(row) : null;
}

/** The ids of every directory, enabled or not, for telling their `accounts` rows apart. */
export async function ldapDirectoryNames(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: oauthProviders.id, name: oauthProviders.name })
    .from(oauthProviders)
    .where(isLdap);
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Whether any of the user's accounts is a directory's. */
export async function hasDirectoryAccount(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(oauthProviders, eq(oauthProviders.id, accounts.providerId))
    .where(and(eq(accounts.userId, userId), isLdap))
    .limit(1);
  return !!row;
}

async function assertNameFree(name: string, exceptId: string | null): Promise<void> {
  // The name index spans OIDC providers too.
  const [clash] = await db
    .select({ id: oauthProviders.id })
    .from(oauthProviders)
    .where(eq(oauthProviders.name, name))
    .limit(1);
  if (clash && clash.id !== exceptId) {
    throw domainError("ldapDirectoryNameTaken", { name }, { status: 409 });
  }
}

function groupMappingColumns(input: Partial<OAuthGroupMapping>) {
  return {
    ...(input.groupPrefix !== undefined && { groupPrefix: input.groupPrefix?.trim() || null }),
    ...(input.roleMappingEnabled !== undefined && {
      roleMappingEnabled: input.roleMappingEnabled,
    }),
    ...(input.adminGroup !== undefined && { adminGroup: input.adminGroup?.trim() || null }),
    ...(input.operatorGroup !== undefined && {
      operatorGroup: input.operatorGroup?.trim() || null,
    }),
    ...(input.userGroup !== undefined && { userGroup: input.userGroup?.trim() || null }),
    ...(input.viewerGroup !== undefined && { viewerGroup: input.viewerGroup?.trim() || null }),
    ...(input.defaultRole !== undefined && {
      defaultRole: isAppRole(input.defaultRole) ? input.defaultRole : "user",
    }),
    ...(input.syncGroups !== undefined && { syncGroups: input.syncGroups }),
  };
}

/** Validated as a whole, so a partial update cannot leave an unusable combination behind. */
function prepare(input: LdapDirectoryInput, existing: LdapDirectory | null) {
  const name = input.name.trim();
  if (!name) throw domainError("ldapNameRequired", {}, { status: 400 });
  const parsedUrl = parseLdapUrl(input.url);
  const config = normalizeLdapConfig({ ...(existing?.config ?? {}), ...input.config });
  validateLdapSettings({ url: input.url, config });
  const bindDn = (input.bindDn ?? existing?.bindDn ?? "").trim();
  const replacement = input.bindPassword?.trim() ? input.bindPassword : null;
  // The stored password only ever goes where it was saved for: otherwise a new address would be a
  // way to read a write-only secret.
  if (
    existing?.bindPassword &&
    !replacement &&
    bindDn &&
    !config.userDnTemplate &&
    (parsedUrl?.url !== existing.url || bindDn !== existing.bindDn)
  ) {
    throw domainError("ldapBindPasswordReentry", {}, { status: 400 });
  }
  const bindPassword = replacement ?? existing?.bindPassword ?? "";
  // A template binds as the user; otherwise a bind DN without a password is an anonymous bind in
  // disguise (RFC 4513 5.1.2), which some servers accept.
  if (!config.userDnTemplate && bindDn && !bindPassword) {
    throw domainError("ldapBindPasswordRequired", {}, { status: 400 });
  }
  return { name, url: parsedUrl?.url ?? "", config, bindDn, bindPassword };
}

/**
 * The directory a form describes, unsaved, for "Test connection". A blank password on an existing
 * directory is its stored one, as saving would keep it.
 */
export async function previewLdapDirectory(
  input: LdapDirectoryInput,
  existingId: string | null,
): Promise<LdapDirectory> {
  const existing = existingId ? await getLdapDirectory(existingId) : null;
  if (existingId && !existing) throw domainError("ldapDirectoryNotFound", {}, { status: 404 });
  const prepared = prepare(input, existing);
  const now = nowIso();
  return {
    id: existing?.id ?? "preview",
    name: prepared.name,
    url: prepared.url,
    bindDn: prepared.config.userDnTemplate ? "" : prepared.bindDn,
    bindPassword: prepared.config.userDnTemplate ? "" : prepared.bindPassword,
    config: prepared.config,
    autoLink: input.autoLink ?? false,
    enabled: true,
    groupsClaim: "memberOf",
    groupPrefix: input.groupPrefix?.trim() || null,
    roleMappingEnabled: input.roleMappingEnabled ?? false,
    adminGroup: input.adminGroup?.trim() || null,
    operatorGroup: input.operatorGroup?.trim() || null,
    userGroup: input.userGroup?.trim() || null,
    viewerGroup: input.viewerGroup?.trim() || null,
    defaultRole: isAppRole(input.defaultRole) ? input.defaultRole : "user",
    syncGroups: input.syncGroups ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function createLdapDirectory(input: LdapDirectoryInput): Promise<LdapDirectory> {
  const prepared = prepare(input, null);
  await assertNameFree(prepared.name, null);
  const now = nowIso();
  const [row] = await db
    .insert(oauthProviders)
    .values({
      id: randomUUID(),
      name: prepared.name,
      type: LDAP_PROVIDER_TYPE,
      clientId: encryptSecret(prepared.config.userDnTemplate ? "" : prepared.bindDn),
      clientSecret: encryptSecret(prepared.config.userDnTemplate ? "" : prepared.bindPassword),
      issuer: prepared.url,
      // An OIDC row's scopes; meaningless here, but the column is NOT NULL.
      scopes: "",
      autoLink: input.autoLink ?? false,
      enabled: input.enabled ?? true,
      source: "ui",
      groupsClaim: "memberOf",
      ...groupMappingColumns(input),
      ldapConfig: JSON.stringify(prepared.config),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return parseRow(row);
}

export async function updateLdapDirectory(
  id: string,
  input: LdapDirectoryInput,
): Promise<LdapDirectory> {
  const existing = await getLdapDirectory(id);
  if (!existing) throw domainError("ldapDirectoryNotFound", {}, { status: 404 });
  const prepared = prepare(input, existing);
  await assertNameFree(prepared.name, id);
  const [row] = await db
    .update(oauthProviders)
    .set({
      name: prepared.name,
      clientId: encryptSecret(prepared.config.userDnTemplate ? "" : prepared.bindDn),
      clientSecret: encryptSecret(prepared.config.userDnTemplate ? "" : prepared.bindPassword),
      issuer: prepared.url,
      ...(input.autoLink !== undefined && { autoLink: input.autoLink }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...groupMappingColumns(input),
      ldapConfig: JSON.stringify(prepared.config),
      updatedAt: nowIso(),
    })
    .where(and(isLdap, eq(oauthProviders.id, id)))
    .returning();
  return parseRow(row);
}

export async function setLdapDirectoryEnabled(
  id: string,
  enabled: boolean,
): Promise<LdapDirectory> {
  const [row] = await db
    .update(oauthProviders)
    .set({ enabled, updatedAt: nowIso() })
    .where(and(isLdap, eq(oauthProviders.id, id)))
    .returning();
  if (!row) throw domainError("ldapDirectoryNotFound", {}, { status: 404 });
  return parseRow(row);
}

/**
 * Whether directories were this user's only way in and none still vouches: no password, no other
 * provider, no enabled directory. `goingId` counts as disabled, for a directory about to be deleted.
 * A passkey registered while a directory vouched must not outlive it.
 */
export async function directoryAccessWithdrawn(userId: number, goingId?: string): Promise<boolean> {
  const rows = await db
    .select({
      providerId: accounts.providerId,
      type: oauthProviders.type,
      enabled: oauthProviders.enabled,
    })
    .from(accounts)
    .leftJoin(oauthProviders, eq(oauthProviders.id, accounts.providerId))
    .where(eq(accounts.userId, userId));
  let directories = 0;
  for (const row of rows) {
    // A `credential` row, another provider, or one deleted before this rule existed.
    if (row.providerId !== goingId && row.type !== LDAP_PROVIDER_TYPE) return false;
    if (row.providerId !== goingId && row.enabled) return false;
    directories++;
  }
  if (directories === 0) return false;
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !user?.passwordHash;
}

/**
 * Its users keep their CPM accounts, but can no longer sign in through it. Those it was the last
 * way in for also lose their passkeys and sessions, which would otherwise keep them in for good.
 */
export async function deleteLdapDirectory(id: string): Promise<LdapDirectory> {
  const existing = await getLdapDirectory(id);
  if (!existing) throw domainError("ldapDirectoryNotFound", {}, { status: 404 });
  const linked = await db
    .selectDistinct({ userId: accounts.userId })
    .from(accounts)
    .where(eq(accounts.providerId, id));
  const stranded: number[] = [];
  for (const { userId } of linked) {
    if (await directoryAccessWithdrawn(userId, id)) stranded.push(userId);
  }
  await db.delete(oauthProviders).where(and(isLdap, eq(oauthProviders.id, id)));
  for (const userId of stranded) {
    await db.delete(passkeys).where(eq(passkeys.userId, userId));
    await revokeSessionsAfterPasswordChange(userId, null);
  }
  return existing;
}
