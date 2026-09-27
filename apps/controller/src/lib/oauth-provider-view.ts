import type { OAuthGroupMapping, OAuthProvider } from "./models/oauth-providers";

/** An explicit allowlist, so a new server-side field never reaches the browser by default. */
export type OAuthProviderView = OAuthGroupMapping & {
  id: string;
  name: string;
  type: string;
  clientId: string;
  hasClientSecret: boolean;
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

export function toOAuthProviderView(provider: OAuthProvider): OAuthProviderView {
  return {
    // The OIDC group mapping drives the provider form, so it crosses the boundary in full.
    groupsClaim: provider.groupsClaim,
    groupPrefix: provider.groupPrefix,
    roleMappingEnabled: provider.roleMappingEnabled,
    adminGroup: provider.adminGroup,
    operatorGroup: provider.operatorGroup,
    userGroup: provider.userGroup,
    viewerGroup: provider.viewerGroup,
    defaultRole: provider.defaultRole,
    syncGroups: provider.syncGroups,
    id: provider.id,
    name: provider.name,
    type: provider.type,
    clientId: provider.clientId,
    hasClientSecret: provider.clientSecret.length > 0,
    issuer: provider.issuer,
    authorizationUrl: provider.authorizationUrl,
    tokenUrl: provider.tokenUrl,
    userinfoUrl: provider.userinfoUrl,
    scopes: provider.scopes,
    autoLink: provider.autoLink,
    enabled: provider.enabled,
    source: provider.source,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

/** Better Auth 1.7 uses the standard social-provider callback route. */
export function oauthCallbackUrl(baseUrl: string, providerId: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  return `${normalizedBaseUrl}/api/auth/callback/${encodeURIComponent(providerId)}`;
}

/** One URL for every provider: a logout token's issuer selects the provider. */
export function oidcBackchannelLogoutUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/auth/oidc/backchannel-logout`;
}

/** Omits the property unless replaced: an empty string would rotate to an unusable credential. */
export function withOAuthClientSecretRotation<T extends object>(
  update: T,
  replacement: string | undefined,
): T & { clientSecret?: string } {
  const clientSecret = replacement?.trim();
  return clientSecret ? { ...update, clientSecret } : update;
}
