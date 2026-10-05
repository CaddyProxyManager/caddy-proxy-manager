import { config } from "../config";
import { APP_ROLES, type AppRole } from "../auth/oidc/groups";
import {
  getOAuthProviderByName,
  createOAuthProvider,
  updateOAuthProvider,
} from "../models/oauth-providers";

/** Sync OAUTH_* env vars into oauthProviders as source="env", read-only in the UI. At startup. */
export async function syncEnvOAuthProviders(): Promise<void> {
  if (!config.oauth.enabled || !config.oauth.clientId || !config.oauth.clientSecret) {
    return;
  }

  const name = config.oauth.providerName;
  const existing = await getOAuthProviderByName(name);

  const validRoles = new Set(APP_ROLES as readonly string[]);
  const data = {
    type: "oidc" as const,
    clientId: config.oauth.clientId,
    clientSecret: config.oauth.clientSecret,
    issuer: config.oauth.issuer ?? null,
    authorizationUrl: config.oauth.authorizationUrl ?? null,
    tokenUrl: config.oauth.tokenUrl ?? null,
    userinfoUrl: config.oauth.userinfoUrl ?? null,
    autoLink: config.oauth.allowAutoLinking,
    scopes: config.oauth.scopes ?? "openid email profile",
    groupsClaim: config.oauth.groupsClaim ?? "groups",
    groupPrefix: config.oauth.groupPrefix ?? null,
    roleMappingEnabled: config.oauth.roleMappingEnabled,
    adminGroup: config.oauth.adminGroup ?? null,
    operatorGroup: config.oauth.operatorGroup ?? null,
    userGroup: config.oauth.userGroup ?? null,
    viewerGroup: config.oauth.viewerGroup ?? null,
    defaultRole: (config.oauth.defaultRole && validRoles.has(config.oauth.defaultRole)
      ? config.oauth.defaultRole
      : "user") as AppRole,
    syncGroups: config.oauth.syncGroups,
  };

  if (existing && existing.source === "env") {
    await updateOAuthProvider(existing.id, { name, ...data });
  } else if (!existing) {
    await createOAuthProvider({ name, ...data, source: "env" });
  }
  // If a UI-sourced provider with the same name exists, don't overwrite it
}
