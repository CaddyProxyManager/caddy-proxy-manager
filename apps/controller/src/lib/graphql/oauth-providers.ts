/**
 * OIDC providers over GraphQL, as `/api/v1/oauth-providers`: the view never carries the client
 * secret, the client id goes out redacted, and an env-sourced provider can only be switched.
 */

import { ApiClientError } from "../api/errors";
import { NotFoundError } from "../api/auth";
import {
  type OAuthProviderView,
  oauthCallbackUrl,
  toOAuthProviderView,
} from "../auth/oidc/provider-view";
import { getPublicBaseUrl } from "../http/public-url";
import { createAuditEvent } from "../models/audit";
import {
  createOAuthProvider,
  deleteOAuthProvider,
  getOAuthProvider,
  updateOAuthProvider,
} from "../models/oauth-providers";
import { assertMayConfigureSignIn } from "../roles/sign-in-sources";
import type { GraphQLContext } from "./context";

type Body = Record<string, unknown>;

function body(input: unknown): Body {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Body) : {};
}

/** Loaded on demand: a static import would pull Better Auth into the schema's module graph. */
async function providersChanged(): Promise<void> {
  const { invalidateProviderCache } = await import("../auth/server");
  invalidateProviderCache();
}

export const oauthProviderFieldResolvers = {
  clientId: (provider: OAuthProviderView) =>
    provider.clientId.length > 4 ? `••••${provider.clientId.slice(-4)}` : "••••",
  // What the operator must register as the redirect URI at the IdP.
  callbackUrl: async (provider: OAuthProviderView) =>
    oauthCallbackUrl(await getPublicBaseUrl(), provider.id),
};

export const oauthProviderMutationResolvers = {
  createOAuthProvider: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
    const input = body(args.input);
    for (const key of ["name", "clientId", "clientSecret"]) {
      if (!input[key] || typeof input[key] !== "string") {
        throw new ApiClientError(`${key} is required`, 400);
      }
    }
    const [{ userId }, { capabilities }] = await Promise.all([context.viewer(), context.access()]);
    await assertMayConfigureSignIn(capabilities, null, input);
    const provider = await createOAuthProvider({
      name: input.name as string,
      type: (input.type as string | undefined) ?? "oidc",
      clientId: input.clientId as string,
      clientSecret: input.clientSecret as string,
      issuer: (input.issuer as string | null | undefined) ?? null,
      authorizationUrl: (input.authorizationUrl as string | null | undefined) ?? null,
      tokenUrl: (input.tokenUrl as string | null | undefined) ?? null,
      userinfoUrl: (input.userinfoUrl as string | null | undefined) ?? null,
      scopes: (input.scopes as string | undefined) ?? "openid email profile",
      autoLink: (input.autoLink as boolean | undefined) ?? false,
      groupsClaim: (input.groupsClaim as string | undefined) ?? undefined,
      rolesClaim: (input.rolesClaim as string | null | undefined) ?? null,
      groupPrefix: (input.groupPrefix as string | null | undefined) ?? null,
      roleMappingEnabled: (input.roleMappingEnabled as boolean | undefined) ?? false,
      adminGroup: (input.adminGroup as string | null | undefined) ?? null,
      operatorGroup: (input.operatorGroup as string | null | undefined) ?? null,
      userGroup: (input.userGroup as string | null | undefined) ?? null,
      viewerGroup: (input.viewerGroup as string | null | undefined) ?? null,
      roleGroups: input.roleGroups as Record<string, string[]> | undefined,
      defaultRole: (input.defaultRole as string | undefined) ?? undefined,
      syncGroups: (input.syncGroups as boolean | undefined) ?? false,
      source: "ui",
    });
    await providersChanged();
    await createAuditEvent({
      userId,
      action: "create",
      entityType: "oauth_provider",
      entityId: null,
      summary: `Created OAuth provider "${provider.name}"`,
      data: JSON.stringify({ providerId: provider.id, name: provider.name, type: provider.type }),
    });
    return toOAuthProviderView(provider);
  },
  updateOAuthProvider: async (
    _: unknown,
    args: { id: string; input: unknown },
    context: GraphQLContext,
  ) => {
    const input = body(args.input);
    const existing = await getOAuthProvider(args.id);
    if (!existing) throw new NotFoundError("OAuth provider not found");
    if (existing.source === "env") {
      const allowedKeys = ["enabled"];
      const disallowed = Object.keys(input).filter(
        (key) => input[key] !== undefined && !allowedKeys.includes(key),
      );
      if (disallowed.length > 0) {
        throw new ApiClientError(
          `Environment-sourced providers can only update: ${allowedKeys.join(", ")}`,
          400,
        );
      }
    }
    const [{ userId }, { capabilities }] = await Promise.all([context.viewer(), context.access()]);
    await assertMayConfigureSignIn(capabilities, existing, input);
    const updated = await updateOAuthProvider(args.id, input as never);
    if (!updated) throw new NotFoundError("OAuth provider not found");
    await providersChanged();
    await createAuditEvent({
      userId,
      action: "update",
      entityType: "oauth_provider",
      entityId: null,
      summary: `Updated OAuth provider "${updated.name}"`,
      data: JSON.stringify({ providerId: updated.id, fields: Object.keys(input) }),
    });
    return toOAuthProviderView(updated);
  },
  deleteOAuthProvider: async (_: unknown, args: { id: string }, context: GraphQLContext) => {
    const existing = await getOAuthProvider(args.id);
    if (!existing) throw new NotFoundError("OAuth provider not found");
    if (existing.source === "env") {
      throw new ApiClientError("Cannot delete an environment-sourced OAuth provider", 400);
    }
    const { userId } = await context.viewer();
    await deleteOAuthProvider(args.id);
    await providersChanged();
    await createAuditEvent({
      userId,
      action: "delete",
      entityType: "oauth_provider",
      entityId: null,
      summary: `Deleted OAuth provider "${existing.name}"`,
      data: JSON.stringify({ providerId: existing.id, name: existing.name }),
    });
    return true;
  },
};
