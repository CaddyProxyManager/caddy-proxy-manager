/**
 * Shapes and defaults of a directory's settings, with nothing server-only, so the editor can use
 * them. Parsing and validation are in config.ts.
 */

export const LDAP_PROVIDER_TYPE = "ldap";

export const USERNAME_PLACEHOLDER = "{username}";

export const LDAP_GROUP_SOURCES = ["memberOf", "search", "none"] as const;
export type LdapGroupSource = (typeof LDAP_GROUP_SOURCES)[number];

export type LdapConfig = {
  baseDn: string;
  /**
   * Searched for after the service bind, or after the user's own bind for a UPN or down-level
   * template; must contain `{username}`.
   */
  userFilter: string;
  /**
   * Binds as the user, with no service account: a DN, `{username}@realm` or `DOMAIN\{username}`
   * (bind-name.ts). Named for the DN form it started as.
   */
  userDnTemplate: string | null;
  startTls: boolean;
  tlsVerify: boolean;
  /** Trusted in addition to the system roots, for a directory with a private CA. */
  caPem: string | null;
  emailAttribute: string;
  nameAttribute: string;
  groupSource: LdapGroupSource;
  /** Where a group search starts; the base DN when empty. */
  groupBaseDn: string | null;
  /** Must contain `{dn}`, the user's DN. */
  groupFilter: string;
  groupNameAttribute: string;
};

/** OpenLDAP-shaped; the editor offers Active Directory's as a preset. */
export const DEFAULT_LDAP_CONFIG: LdapConfig = {
  baseDn: "",
  userFilter: "(&(objectClass=person)(uid={username}))",
  userDnTemplate: null,
  startTls: false,
  tlsVerify: true,
  caPem: null,
  emailAttribute: "mail",
  nameAttribute: "displayName",
  groupSource: "memberOf",
  groupBaseDn: null,
  groupFilter: "(|(member={dn})(uniqueMember={dn}))",
  groupNameAttribute: "cn",
};

/** AD's nested-membership rule, so a user in a group inside a mapped group matches too. */
export const ACTIVE_DIRECTORY_PRESET: Partial<LdapConfig> = {
  userFilter: "(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))",
  nameAttribute: "displayName",
  groupSource: "search",
  groupFilter: "(member:1.2.840.113556.1.4.1941:={dn})",
};

/** The OpenLDAP-shaped bind DN offered when binding as the user. */
export const DN_BIND_TEMPLATE_EXAMPLE = "uid={username},ou=people,dc=example,dc=org";

/**
 * The AD preset's bind name: a UPN with the base DN's domain as its suffix, AD's default one.
 * `DC=ad,DC=example,DC=org` gives `{username}@ad.example.org`.
 */
export function activeDirectoryBindTemplate(baseDn: string): string {
  const labels = baseDn
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^dc=/i.test(part))
    .map((part) => part.slice(3).trim())
    .filter(Boolean);
  return `${USERNAME_PLACEHOLDER}@${labels.length > 0 ? labels.join(".") : "example.org"}`;
}
