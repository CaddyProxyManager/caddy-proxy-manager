import { randomUUID } from "node:crypto";
import db, { nowIso } from "../db";
import { oauthProviders, settings } from "../db/schema";
import { and, asc, eq, ne } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../secrets";
import type { AppRole } from "../auth/oidc/groups";
import { isAppRole } from "../auth/oidc/groups";
import { toOAuthProviderView, type OAuthProviderView } from "../auth/oidc/provider-view";
import { domainError } from "../errors/domain-error";
import { LDAP_PROVIDER_TYPE } from "../ldap/defaults";

/** LDAP directories share the table (models/ldap-directories.ts); no reader here may see one. */
const isOidc = ne(oauthProviders.type, LDAP_PROVIDER_TYPE);

/** A directory is made through its own model, never turned into one here. */
function assertOidcType(type: string | undefined): void {
  if (type === LDAP_PROVIDER_TYPE)
    throw domainError("oauthProviderTypeInvalid", {}, { status: 400 });
}

/** Per-provider OIDC group mapping, shared by the type, create and update paths. */
export type OAuthGroupMapping = {
  groupsClaim: string;
  groupPrefix: string | null;
  roleMappingEnabled: boolean;
  adminGroup: string | null;
  operatorGroup: string | null;
  userGroup: string | null;
  viewerGroup: string | null;
  defaultRole: AppRole;
  syncGroups: boolean;
};

export type OAuthProvider = OAuthGroupMapping & {
  id: string;
  name: string;
  type: string;
  clientId: string;
  clientSecret: string;
  issuer: string | null;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  userinfoUrl: string | null;
  scopes: string;
  autoLink: boolean;
  enabled: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
};

type DbProvider = typeof oauthProviders.$inferSelect;

function parseDbProvider(row: DbProvider): OAuthProvider {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    clientId: decryptSecret(row.clientId),
    clientSecret: decryptSecret(row.clientSecret),
    issuer: row.issuer,
    authorizationUrl: row.authorizationUrl,
    tokenUrl: row.tokenUrl,
    userinfoUrl: row.userinfoUrl,
    scopes: row.scopes,
    autoLink: row.autoLink,
    enabled: row.enabled,
    source: row.source,
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

export async function createOAuthProvider(
  data: {
    name: string;
    type?: string;
    clientId: string;
    clientSecret: string;
    issuer?: string | null;
    authorizationUrl?: string | null;
    tokenUrl?: string | null;
    userinfoUrl?: string | null;
    scopes?: string;
    autoLink?: boolean;
    enabled?: boolean;
    source?: string;
  } & Partial<OAuthGroupMapping>,
): Promise<OAuthProvider> {
  assertOidcType(data.type);
  const now = nowIso();
  const id = randomUUID();

  const [row] = await db
    .insert(oauthProviders)
    .values({
      id,
      name: data.name,
      type: data.type ?? "oidc",
      clientId: encryptSecret(data.clientId),
      clientSecret: encryptSecret(data.clientSecret),
      issuer: data.issuer ?? null,
      authorizationUrl: data.authorizationUrl ?? null,
      tokenUrl: data.tokenUrl ?? null,
      userinfoUrl: data.userinfoUrl ?? null,
      scopes: data.scopes ?? "openid email profile",
      autoLink: data.autoLink ?? false,
      enabled: data.enabled ?? true,
      source: data.source ?? "ui",
      groupsClaim: data.groupsClaim?.trim() || "groups",
      groupPrefix: data.groupPrefix?.trim() || null,
      roleMappingEnabled: data.roleMappingEnabled ?? false,
      adminGroup: data.adminGroup?.trim() || null,
      operatorGroup: data.operatorGroup?.trim() || null,
      userGroup: data.userGroup?.trim() || null,
      viewerGroup: data.viewerGroup?.trim() || null,
      defaultRole: isAppRole(data.defaultRole) ? data.defaultRole : "user",
      syncGroups: data.syncGroups ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return parseDbProvider(row);
}

export async function listOAuthProviders(): Promise<OAuthProviderView[]> {
  const rows = await db
    .select()
    .from(oauthProviders)
    .where(isOidc)
    .orderBy(asc(oauthProviders.name));
  return rows.map((row) => toOAuthProviderView(parseDbProvider(row)));
}

export async function listEnabledOAuthProviders(): Promise<OAuthProvider[]> {
  const rows = await db
    .select()
    .from(oauthProviders)
    .where(and(isOidc, eq(oauthProviders.enabled, true)))
    .orderBy(asc(oauthProviders.name));
  return rows.map(parseDbProvider);
}

export async function getOAuthProvider(id: string): Promise<OAuthProvider | null> {
  const [row] = await db
    .select()
    .from(oauthProviders)
    .where(and(isOidc, eq(oauthProviders.id, id)))
    .limit(1);
  return row ? parseDbProvider(row) : null;
}

/** Unfiltered: the env sync must see a directory holding the name, or its insert would clash. */
export async function getOAuthProviderByName(name: string): Promise<OAuthProvider | null> {
  const row = await db.query.oauthProviders.findFirst({
    where: (table, { eq }) => eq(table.name, name),
  });
  return row ? parseDbProvider(row) : null;
}

export async function updateOAuthProvider(
  id: string,
  data: Partial<{
    name: string;
    type: string;
    clientId: string;
    clientSecret: string;
    issuer: string | null;
    authorizationUrl: string | null;
    tokenUrl: string | null;
    userinfoUrl: string | null;
    scopes: string;
    autoLink: boolean;
    enabled: boolean;
  }> &
    Partial<OAuthGroupMapping>,
): Promise<OAuthProvider | null> {
  assertOidcType(data.type);
  const now = nowIso();

  const updates: Record<string, unknown> = { updatedAt: now };

  if (data.name !== undefined) updates.name = data.name;
  if (data.type !== undefined) updates.type = data.type;
  if (data.clientId !== undefined) updates.clientId = encryptSecret(data.clientId);
  // A blank value means "preserve" at the server boundary as well as in the
  // UI. Rotation requires an explicit non-empty replacement.
  if (data.clientSecret !== undefined && data.clientSecret.trim().length > 0) {
    updates.clientSecret = encryptSecret(data.clientSecret.trim());
  }
  if (data.issuer !== undefined) updates.issuer = data.issuer;
  if (data.authorizationUrl !== undefined) updates.authorizationUrl = data.authorizationUrl;
  if (data.tokenUrl !== undefined) updates.tokenUrl = data.tokenUrl;
  if (data.userinfoUrl !== undefined) updates.userinfoUrl = data.userinfoUrl;
  if (data.scopes !== undefined) updates.scopes = data.scopes;
  if (data.autoLink !== undefined) updates.autoLink = data.autoLink;
  if (data.enabled !== undefined) updates.enabled = data.enabled;
  if (data.groupsClaim !== undefined) updates.groupsClaim = data.groupsClaim.trim() || "groups";
  if (data.groupPrefix !== undefined) updates.groupPrefix = data.groupPrefix?.trim() || null;
  if (data.roleMappingEnabled !== undefined) updates.roleMappingEnabled = data.roleMappingEnabled;
  if (data.adminGroup !== undefined) updates.adminGroup = data.adminGroup?.trim() || null;
  if (data.operatorGroup !== undefined) updates.operatorGroup = data.operatorGroup?.trim() || null;
  if (data.userGroup !== undefined) updates.userGroup = data.userGroup?.trim() || null;
  if (data.viewerGroup !== undefined) updates.viewerGroup = data.viewerGroup?.trim() || null;
  if (data.defaultRole !== undefined)
    updates.defaultRole = isAppRole(data.defaultRole) ? data.defaultRole : "user";
  if (data.syncGroups !== undefined) updates.syncGroups = data.syncGroups;

  const [row] = await db
    .update(oauthProviders)
    .set(updates)
    .where(and(isOidc, eq(oauthProviders.id, id)))
    .returning();

  return row ? parseDbProvider(row) : null;
}

export async function deleteOAuthProvider(id: string): Promise<void> {
  const row = await getOAuthProvider(id);

  if (!row) {
    throw domainError("oauthProviderNotFound");
  }

  if (row.source === "env") {
    throw domainError("environmentOAuthProviderDeletionForbidden");
  }

  await db.delete(oauthProviders).where(and(isOidc, eq(oauthProviders.id, id)));
}

/**
 * A settings key, not a column: a single value makes "two primaries" unrepresentable. The id may
 * name a deleted or disabled provider, so reads resolve it against the live list.
 */
const PRIMARY_PROVIDER_KEY = "auth:primary_provider";

/** The configured primary provider's id, or null when the operator has not chosen one. */
export async function getPrimaryProviderId(): Promise<string | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, PRIMARY_PROVIDER_KEY))
    .limit(1);
  return row?.value ?? null;
}

/** Choose the primary provider, or pass null to go back to listing them alphabetically. */
export async function setPrimaryProviderId(id: string | null): Promise<void> {
  const now = nowIso();
  if (id === null) {
    await db.delete(settings).where(eq(settings.key, PRIMARY_PROVIDER_KEY));
    return;
  }
  await db
    .insert(settings)
    .values({ key: PRIMARY_PROVIDER_KEY, value: id, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: id, updatedAt: now } });
}

export async function getProviderDisplayList(): Promise<
  Array<{ id: string; name: string; autoLink: boolean; isPrimary: boolean }>
> {
  const rows = await db
    .select({
      id: oauthProviders.id,
      name: oauthProviders.name,
      autoLink: oauthProviders.autoLink,
    })
    .from(oauthProviders)
    .where(and(isOidc, eq(oauthProviders.enabled, true)))
    .orderBy(asc(oauthProviders.name));
  const primaryId = await getPrimaryProviderId();
  const list = rows.map((r) => ({
    id: r.id,
    name: r.name,
    autoLink: r.autoLink,
    // Resolved against this list, so a stale id from a deleted or disabled provider simply
    // means no primary rather than a marker nothing matches.
    isPrimary: r.id === primaryId,
  }));
  // The primary is offered first; everything else keeps the alphabetical order.
  return [...list.filter((p) => p.isPrimary), ...list.filter((p) => !p.isPrimary)];
}
