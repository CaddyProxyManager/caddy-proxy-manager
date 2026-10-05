/**
 * How people sign in to this instance, on one page: each method and whether it is on, how many
 * accounts use it, whether each directory answers, which groups become which role, and what the
 * login page offers as a result. Read-only; every switch it reports lives in Settings.
 */
import { and, count, eq, isNotNull, ne } from "drizzle-orm";
import db from "../db";
import { groups, oauthProviders, passkeys, users } from "../db/schema";
import { authPolicy } from "../auth/policy";
import { getTwoFactorPolicySettings } from "../settings";
import { getPrimaryProviderId } from "../models/oauth-providers";
import { listLdapDirectories, listEnabledLdapDirectories } from "../models/ldap-directories";
import { listAllMappings } from "../models/group-idp-mappings";
import { checkLdapDirectories } from "../ldap/health";
import { LDAP_PROVIDER_TYPE } from "../ldap/defaults";
import { passkeyRpId } from "../auth/passkeys/relying-party";
import { getPublicBaseUrl } from "../http/public-url";
import { linkedAccountCounts } from "./account-source";
import { usersWithPassword } from "../models/user";
import type { MfaPolicyMode } from "../auth/two-factor/mfa-policy";

/** Long enough for a reachable directory to answer, short enough not to hold the page. */
const LDAP_BUDGET_MS = 4_000;

export type RoleMapping = {
  enabled: boolean;
  admin: string | null;
  operator: string | null;
  user: string | null;
  viewer: string | null;
  defaultRole: string;
};

export type SignInOverview = {
  password: {
    enabled: boolean;
    selfRegistration: boolean;
    /** Accounts with a local password. */
    accounts: number;
  };
  passkeys: {
    enabled: boolean;
    /** The Public URL's hostname they are bound to; null when it does not parse. */
    rpId: string | null;
    registered: number;
    accounts: number;
  };
  providers: Array<{
    id: string;
    name: string;
    enabled: boolean;
    primary: boolean;
    autoLink: boolean;
    linked: number;
    syncGroups: boolean;
    roles: RoleMapping;
  }>;
  /** Whether a first sign-in through a provider or directory may create an account. */
  externalRegistration: boolean;
  directories: Array<{
    id: string;
    name: string;
    enabled: boolean;
    linked: number;
    /** "unchecked" when disabled, or still being checked past the budget. */
    health: "ok" | "unreachable" | "unchecked";
    failure: string | null;
    syncGroups: boolean;
    roles: RoleMapping;
  }>;
  groupMappings: Array<{ group: string; provider: string | null; externalName: string }>;
  mfa: { mode: MfaPolicyMode; graceDays: number; withTotp: number; withPasskey: number };
};

function roles(source: {
  roleMappingEnabled: boolean;
  adminGroup: string | null;
  operatorGroup: string | null;
  userGroup: string | null;
  viewerGroup: string | null;
  defaultRole: string;
}): RoleMapping {
  return {
    enabled: source.roleMappingEnabled,
    admin: source.adminGroup,
    operator: source.operatorGroup,
    user: source.userGroup,
    viewer: source.viewerGroup,
    defaultRole: source.defaultRole,
  };
}

async function withinBudget<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), LDAP_BUDGET_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getSignInOverview(): Promise<SignInOverview> {
  const [
    policy,
    mfa,
    primaryId,
    providerRows,
    directories,
    enabledDirectories,
    linked,
    withPassword,
    [passkeyTotal],
    passkeyUsers,
    [totpUsers],
    mappings,
    groupRows,
    publicBaseUrl,
  ] = await Promise.all([
    authPolicy(),
    getTwoFactorPolicySettings(),
    getPrimaryProviderId(),
    // Not the model's list: that decrypts client secrets this page has no use for.
    db.select().from(oauthProviders).where(ne(oauthProviders.type, LDAP_PROVIDER_TYPE)),
    listLdapDirectories(),
    listEnabledLdapDirectories(),
    linkedAccountCounts(),
    usersWithPassword(),
    db.select({ total: count() }).from(passkeys),
    db.selectDistinct({ userId: passkeys.userId }).from(passkeys),
    db
      .select({ total: count() })
      .from(users)
      .where(and(eq(users.twoFactorEnabled, true), eq(users.status, "active"))),
    listAllMappings(),
    db.select({ id: groups.id, name: groups.name }).from(groups),
    getPublicBaseUrl(),
  ]);
  const passwordUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(isNotNull(users.passwordHash));
  const passwordAccounts = new Set([...withPassword, ...passwordUsers.map((row) => row.id)]).size;

  const health = await withinBudget(
    checkLdapDirectories(enabledDirectories),
    new Map<string, { at: number; failure: string | null }>(),
  );
  const groupNames = new Map(groupRows.map((row) => [row.id, row.name]));
  const providerNames = new Map<string, string>([
    ...providerRows.map((row) => [row.id, row.name] as const),
    ...directories.map((directory) => [directory.id, directory.name] as const),
  ]);
  const rpId = passkeyRpId(publicBaseUrl);

  return {
    password: {
      enabled: !policy.disableLocalUsers,
      selfRegistration: !policy.disableLocalUsers && policy.allowSelfRegistration,
      accounts: passwordAccounts,
    },
    passkeys: {
      enabled: !policy.disableLocalUsers && rpId !== null,
      rpId,
      registered: Number(passkeyTotal?.total ?? 0),
      accounts: passkeyUsers.length,
    },
    providers: providerRows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      primary: row.id === primaryId,
      autoLink: row.autoLink,
      linked: linked.get(row.id) ?? 0,
      syncGroups: row.syncGroups,
      roles: roles(row),
    })),
    externalRegistration: policy.allowOauthRegistration,
    directories: directories.map((directory) => {
      const check = health.get(directory.id);
      return {
        id: directory.id,
        name: directory.name,
        enabled: directory.enabled,
        linked: linked.get(directory.id) ?? 0,
        health: !directory.enabled || !check ? "unchecked" : check.failure ? "unreachable" : "ok",
        failure: check?.failure ?? null,
        syncGroups: directory.syncGroups,
        roles: roles(directory),
      };
    }),
    groupMappings: [...mappings.values()].flat().map((mapping) => ({
      group: groupNames.get(mapping.groupId) ?? String(mapping.groupId),
      provider: mapping.providerId ? (providerNames.get(mapping.providerId) ?? null) : null,
      externalName: mapping.externalName,
    })),
    mfa: {
      mode: mfa.mode,
      graceDays: mfa.graceDays,
      withTotp: Number(totpUsers?.total ?? 0),
      withPasskey: passkeyUsers.length,
    },
  };
}
