/**
 * SAML identity providers. Each is two rows: CPM's `oauth_providers` row (type 'saml') for the
 * name, the switch and the group mapping, so role mappings, linked accounts and the sign-in page
 * treat it as any provider; and the plugin's `sso_providers` row for what the plugin verifies.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { nowIso, runInTransaction } from "../db";
import { oauthProviders, ssoProviders } from "../db/schema";
import { encryptSecret } from "../secrets";
import { isKnownRole } from "../roles/store";
import {
  type LegacyRoleColumns,
  type RoleGroups,
  requestedRoleGroups,
  setRoleGroups,
  withRoleGroups,
} from "../roles/mappings";
import { domainError } from "../errors/domain-error";
import type { OAuthGroupMapping } from "./oauth-providers";
import { fetchIdpMetadata, readIdpMetadata } from "../auth/saml/metadata";
import { SAML_GROUPS_FIELD, SAML_PROVIDER_TYPE, defaultSpEntityId } from "../auth/saml/urls";
import type { OutboundFetch } from "../http/outbound";
import { hasForbiddenControlCharacter } from "../settings/validation";

export const DEFAULT_SAML_ATTRIBUTES = {
  email: "email",
  name: "displayName",
  groups: "groups",
} as const;

/** Everything here is public: metadata, certificates and attribute names. Nothing is secret. */
export type SamlProvider = OAuthGroupMapping & {
  id: string;
  name: string;
  enabled: boolean;
  /** Fetched again on every save when set; the stored copy is what sign-in trusts. */
  metadataUrl: string | null;
  metadataXml: string;
  idpEntityId: string;
  ssoUrl: string;
  certificateCount: number;
  spEntityId: string;
  emailAttribute: string;
  nameAttribute: string;
  /** Email domains whose first sign-in joins an existing account with the same email. */
  linkDomains: string;
  createdAt: string;
  updatedAt: string;
};

export type SamlProviderInput = Partial<OAuthGroupMapping> & {
  name: string;
  metadataUrl?: string | null;
  metadataXml?: string | null;
  spEntityId?: string;
  emailAttribute?: string;
  nameAttribute?: string;
  linkDomains?: string;
  enabled?: boolean;
};

type StoredSamlConfig = {
  issuer?: string;
  idpMetadata?: { metadata?: string };
  mapping?: { email?: string; name?: string; extraFields?: Record<string, string> };
};

type OAuthRow = typeof oauthProviders.$inferSelect & LegacyRoleColumns & { roleGroups: RoleGroups };
type SsoRow = typeof ssoProviders.$inferSelect;

function parseConfig(row: SsoRow | undefined): StoredSamlConfig {
  try {
    return row?.samlConfig ? (JSON.parse(row.samlConfig) as StoredSamlConfig) : {};
  } catch {
    return {};
  }
}

function parse(row: OAuthRow, sso: SsoRow | undefined): SamlProvider {
  const config = parseConfig(sso);
  const metadataXml = config.idpMetadata?.metadata ?? "";
  let idp = { entityId: "", ssoUrl: "", signingCertificates: [] as string[] };
  try {
    idp = readIdpMetadata(metadataXml);
  } catch {
    // Saved before it was checked, or emptied by hand: shown as missing rather than failing the list.
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    metadataUrl: row.issuer,
    metadataXml,
    idpEntityId: idp.entityId,
    ssoUrl: idp.ssoUrl,
    certificateCount: idp.signingCertificates.length,
    spEntityId: sso?.issuer ?? "",
    emailAttribute: config.mapping?.email ?? DEFAULT_SAML_ATTRIBUTES.email,
    nameAttribute: config.mapping?.name ?? DEFAULT_SAML_ATTRIBUTES.name,
    linkDomains: sso?.domain ?? "",
    groupsClaim: row.groupsClaim,
    groupPrefix: row.groupPrefix,
    roleMappingEnabled: row.roleMappingEnabled,
    adminGroup: row.adminGroup,
    operatorGroup: row.operatorGroup,
    userGroup: row.userGroup,
    viewerGroup: row.viewerGroup,
    roleGroups: row.roleGroups,
    defaultRole: row.defaultRole,
    syncGroups: row.syncGroups,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const isSaml = eq(oauthProviders.type, SAML_PROVIDER_TYPE);

async function load(where: ReturnType<typeof and>): Promise<SamlProvider[]> {
  const rows = await db.select().from(oauthProviders).where(where).orderBy(oauthProviders.name);
  if (rows.length === 0) return [];
  const [withGroups, ssoRows] = await Promise.all([
    withRoleGroups(rows),
    db.select().from(ssoProviders),
  ]);
  const byProvider = new Map(ssoRows.map((row) => [row.providerId, row]));
  return withGroups.map((row) => parse(row, byProvider.get(row.id)));
}

export async function listSamlProviders(): Promise<SamlProvider[]> {
  return load(isSaml);
}

export async function getSamlProvider(id: string): Promise<SamlProvider | null> {
  const [provider] = await load(and(isSaml, eq(oauthProviders.id, id)));
  return provider ?? null;
}

function cleanAttribute(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > 255 || hasForbiddenControlCharacter(trimmed)) {
    throw domainError("samlAttributeInvalid", {}, { status: 400 });
  }
  return trimmed || fallback;
}

/** Comma-separated, lower-cased, each a hostname. Empty links nothing. */
export function normalizeLinkDomains(value: string | undefined): string {
  const domains = (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  for (const domain of domains) {
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      throw domainError("samlLinkDomainInvalid", { domain }, { status: 400 });
    }
  }
  return [...new Set(domains)].join(",");
}

function cleanSpEntityId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024 || /\s/.test(trimmed)) {
    throw domainError("samlSpEntityIdInvalid", {}, { status: 400 });
  }
  return trimmed;
}

async function assertNameFree(name: string, exceptId: string | null): Promise<void> {
  // The name index spans every provider and directory.
  const [clash] = await db
    .select({ id: oauthProviders.id })
    .from(oauthProviders)
    .where(eq(oauthProviders.name, name))
    .limit(1);
  if (clash && clash.id !== exceptId) {
    throw domainError("ldapDirectoryNameTaken", { name }, { status: 409 });
  }
}

/** The metadata a form asked for: fetched from its URL when it has one, else as pasted. */
async function resolveMetadata(
  input: SamlProviderInput,
  existing: SamlProvider | null,
  fetcher?: OutboundFetch,
): Promise<{ url: string | null; xml: string }> {
  const url = input.metadataUrl === undefined ? (existing?.metadataUrl ?? null) : input.metadataUrl;
  const trimmedUrl = url?.trim() || null;
  if (trimmedUrl) return { url: trimmedUrl, xml: await fetchIdpMetadata(trimmedUrl, fetcher) };
  const xml = input.metadataXml?.trim() || existing?.metadataXml || "";
  return { url: null, xml };
}

function samlConfig(spEntityId: string, metadataXml: string, attributes: Record<string, string>) {
  const idp = readIdpMetadata(metadataXml);
  return JSON.stringify({
    issuer: spEntityId,
    entryPoint: idp.ssoUrl,
    idpMetadata: { metadata: metadataXml.trim() },
    // The plugin then refuses an assertion that is not itself signed: a signed response around
    // an unsigned assertion is how signature wrapping gets in.
    wantAssertionsSigned: true,
    authnRequestsSigned: false,
    mapping: {
      email: attributes.email,
      name: attributes.name,
      extraFields: { [SAML_GROUPS_FIELD]: attributes.groups },
    },
  });
}

async function groupMappingColumns(input: Partial<OAuthGroupMapping>) {
  return {
    ...(input.groupPrefix !== undefined && { groupPrefix: input.groupPrefix?.trim() || null }),
    ...(input.roleMappingEnabled !== undefined && {
      roleMappingEnabled: input.roleMappingEnabled,
    }),
    ...(input.defaultRole !== undefined && {
      defaultRole: (await isKnownRole(input.defaultRole)) ? input.defaultRole : "user",
    }),
    ...(input.syncGroups !== undefined && { syncGroups: input.syncGroups }),
  };
}

export async function createSamlProvider(
  input: SamlProviderInput,
  options: { baseUrl: string; fetcher?: OutboundFetch },
): Promise<SamlProvider> {
  const name = input.name.trim();
  if (!name) throw domainError("samlNameRequired", {}, { status: 400 });
  await assertNameFree(name, null);
  const id = randomUUID();
  const metadata = await resolveMetadata(input, null, options.fetcher);
  const attributes = {
    email: cleanAttribute(input.emailAttribute, DEFAULT_SAML_ATTRIBUTES.email),
    name: cleanAttribute(input.nameAttribute, DEFAULT_SAML_ATTRIBUTES.name),
    groups: cleanAttribute(input.groupsClaim, DEFAULT_SAML_ATTRIBUTES.groups),
  };
  const spEntityId = cleanSpEntityId(input.spEntityId || defaultSpEntityId(options.baseUrl, id));
  const config = samlConfig(spEntityId, metadata.xml, attributes);
  const linkDomains = normalizeLinkDomains(input.linkDomains);
  const columns = await groupMappingColumns(input);
  const now = nowIso();

  await runInTransaction((tx) => [
    tx.insert(oauthProviders).values({
      id,
      name,
      type: SAML_PROVIDER_TYPE,
      // Not NULL columns an OIDC client fills; a SAML provider has no client credentials.
      clientId: encryptSecret(""),
      clientSecret: encryptSecret(""),
      issuer: metadata.url,
      scopes: "",
      autoLink: linkDomains !== "",
      enabled: input.enabled ?? true,
      source: "ui",
      groupsClaim: attributes.groups,
      ...columns,
      createdAt: now,
      updatedAt: now,
    }),
    tx.insert(ssoProviders).values({
      issuer: spEntityId,
      samlConfig: config,
      // The plugin's owner, for its own management routes, which CPM disables; and a user row
      // a partial migration might not bring.
      userId: null,
      providerId: id,
      domain: linkDomains,
      domainVerified: true,
    }),
  ]);
  await setRoleGroups(id, requestedRoleGroups(input));
  const created = await getSamlProvider(id);
  if (!created) throw domainError("samlProviderNotFound", {}, { status: 404 });
  return created;
}

export async function updateSamlProvider(
  id: string,
  input: Partial<SamlProviderInput>,
  options: { fetcher?: OutboundFetch } = {},
): Promise<SamlProvider> {
  const existing = await getSamlProvider(id);
  if (!existing) throw domainError("samlProviderNotFound", {}, { status: 404 });
  const name = input.name === undefined ? existing.name : input.name.trim();
  if (!name) throw domainError("samlNameRequired", {}, { status: 400 });
  await assertNameFree(name, id);

  // A switch flipped from the list carries nothing else, and must not refetch the metadata.
  const configChanged = [
    "metadataUrl",
    "metadataXml",
    "spEntityId",
    "emailAttribute",
    "nameAttribute",
    "groupsClaim",
  ].some((key) => key in input);
  const metadata = configChanged
    ? await resolveMetadata(input as SamlProviderInput, existing, options.fetcher)
    : { url: existing.metadataUrl, xml: existing.metadataXml };
  const attributes = {
    email: cleanAttribute(
      input.emailAttribute ?? existing.emailAttribute,
      DEFAULT_SAML_ATTRIBUTES.email,
    ),
    name: cleanAttribute(
      input.nameAttribute ?? existing.nameAttribute,
      DEFAULT_SAML_ATTRIBUTES.name,
    ),
    groups: cleanAttribute(
      input.groupsClaim ?? existing.groupsClaim,
      DEFAULT_SAML_ATTRIBUTES.groups,
    ),
  };
  const spEntityId = cleanSpEntityId(input.spEntityId ?? existing.spEntityId);
  const config = configChanged ? samlConfig(spEntityId, metadata.xml, attributes) : null;
  const linkDomains =
    input.linkDomains === undefined
      ? existing.linkDomains
      : normalizeLinkDomains(input.linkDomains);
  const columns = await groupMappingColumns(input);

  await runInTransaction((tx) => [
    tx
      .update(oauthProviders)
      .set({
        name,
        issuer: metadata.url,
        autoLink: linkDomains !== "",
        groupsClaim: attributes.groups,
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...columns,
        updatedAt: nowIso(),
      })
      .where(and(isSaml, eq(oauthProviders.id, id))),
    tx
      .update(ssoProviders)
      .set({ issuer: spEntityId, domain: linkDomains, ...(config && { samlConfig: config }) })
      .where(eq(ssoProviders.providerId, id)),
  ]);
  await setRoleGroups(id, requestedRoleGroups(input));
  const updated = await getSamlProvider(id);
  if (!updated) throw domainError("samlProviderNotFound", {}, { status: 404 });
  return updated;
}

/** Its users keep their CPM accounts; the plugin's row goes with the provider's (cascade). */
export async function deleteSamlProvider(id: string): Promise<SamlProvider> {
  const existing = await getSamlProvider(id);
  if (!existing) throw domainError("samlProviderNotFound", {}, { status: 404 });
  await db.delete(oauthProviders).where(and(isSaml, eq(oauthProviders.id, id)));
  return existing;
}
