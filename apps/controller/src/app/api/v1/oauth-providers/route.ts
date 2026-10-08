import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { listOAuthProviders, createOAuthProvider } from "@/src/lib/models/oauth-providers";
import {
  oauthCallbackUrl,
  toOAuthProviderView,
  type OAuthProviderView,
} from "@/src/lib/auth/oidc/provider-view";
import { createAuditEvent } from "@/src/lib/models/audit";
import { invalidateProviderCache } from "@/src/lib/auth/server";
import { getPublicBaseUrl } from "@/src/lib/http/public-url";
import { assertMayConfigureSignIn } from "@/src/lib/roles/sign-in-sources";

const PRIVATE_RESPONSE_HEADERS = { "Cache-Control": "no-store" };

function redactClientId(provider: OAuthProviderView, baseUrl: string) {
  const clientId = provider.clientId;
  return {
    ...provider,
    clientId: clientId.length > 4 ? `••••${clientId.slice(-4)}` : "••••",
    // What the operator must register as the redirect URI at the IdP.
    callbackUrl: oauthCallbackUrl(baseUrl, provider.id),
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
    const [providers, baseUrl] = await Promise.all([listOAuthProviders(), getPublicBaseUrl()]);
    return NextResponse.json(
      providers.map((provider) => redactClientId(provider, baseUrl)),
      {
        headers: PRIVATE_RESPONSE_HEADERS,
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId, access } = await requireApiUser(request);
    const body = await request.json();

    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!body.clientId || typeof body.clientId !== "string") {
      return NextResponse.json({ error: "clientId is required" }, { status: 400 });
    }
    if (!body.clientSecret || typeof body.clientSecret !== "string") {
      return NextResponse.json({ error: "clientSecret is required" }, { status: 400 });
    }

    await assertMayConfigureSignIn(access.capabilities, null, body);
    const provider = await createOAuthProvider({
      name: body.name,
      type: body.type ?? "oidc",
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      issuer: body.issuer ?? null,
      authorizationUrl: body.authorizationUrl ?? null,
      tokenUrl: body.tokenUrl ?? null,
      userinfoUrl: body.userinfoUrl ?? null,
      scopes: body.scopes ?? "openid email profile",
      autoLink: body.autoLink ?? false,
      groupsClaim: body.groupsClaim ?? undefined,
      groupPrefix: body.groupPrefix ?? null,
      roleMappingEnabled: body.roleMappingEnabled ?? false,
      adminGroup: body.adminGroup ?? null,
      operatorGroup: body.operatorGroup ?? null,
      userGroup: body.userGroup ?? null,
      viewerGroup: body.viewerGroup ?? null,
      defaultRole: body.defaultRole ?? undefined,
      syncGroups: body.syncGroups ?? false,
      source: "ui",
    });

    invalidateProviderCache();

    await createAuditEvent({
      userId,
      action: "create",
      entityType: "oauth_provider",
      entityId: null,
      summary: `Created OAuth provider "${provider.name}"`,
      data: JSON.stringify({ providerId: provider.id, name: provider.name, type: provider.type }),
    });

    return NextResponse.json(
      redactClientId(toOAuthProviderView(provider), await getPublicBaseUrl()),
      {
        status: 201,
        headers: PRIVATE_RESPONSE_HEADERS,
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
