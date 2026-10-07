/**
 * "Enforce single sign-on": passwords and passkeys typed into CPM stop working, except for the
 * named break-glass accounts, so the identity provider (and its MFA) decides who gets in. LDAP is
 * a password typed into CPM too, but its accounts live in a directory, so it has its own switch.
 * `cpm-server --lift-sso-enforcement` turns it off from the console. No server imports: the
 * Settings form shares it; what reads the database is in sso-break-glass.ts.
 */
export type SsoEnforcement = {
  enforced: boolean;
  /** Accounts whose own password or passkey keeps working, for when the provider is down. */
  breakGlassUserIds: number[];
  /** Directory sign-in while enforced. On by default: the directory owns those accounts. */
  allowLdap: boolean;
};

export const DEFAULT_SSO_ENFORCEMENT: SsoEnforcement = {
  enforced: false,
  breakGlassUserIds: [],
  allowLdap: true,
};

export const MAX_BREAK_GLASS_ACCOUNTS = 20;

export function readSsoEnforcement(stored: unknown): SsoEnforcement {
  const raw =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const ids = Array.isArray(raw.breakGlassUserIds) ? raw.breakGlassUserIds : [];
  return {
    enforced: raw.enforced === true,
    breakGlassUserIds: [
      ...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)),
    ].slice(0, MAX_BREAK_GLASS_ACCOUNTS),
    allowLdap: raw.allowLdap !== false,
  };
}

export function isBreakGlassAccount(policy: SsoEnforcement, userId: number): boolean {
  return policy.breakGlassUserIds.includes(userId);
}
