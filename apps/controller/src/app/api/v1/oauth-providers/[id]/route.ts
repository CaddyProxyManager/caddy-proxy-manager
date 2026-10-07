import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import {
  getOAuthProvider,
  updateOAuthProvider,
  deleteOAuthProvider,
} from "@/src/lib/models/oauth-providers";
import {
  oauthCallbackUrl,
  toOAuthProviderView,
  type OAuthProviderView,
} from "@/src/lib/auth/oidc/provider-view";
import { createAuditEvent } from "@/src/lib/models/audit";
import { invalidateProviderCache } from "@/src/lib/auth/server";
import { getPublicBaseUrl } from "@/src/lib/http/public-url";

const PRIVATE_RESPONSE_HEADERS = { "Cache-Control": "no-store" };

async function redactClientId(provider: OAuthProviderView) {
  const clientId = provider.clientId;
  return {
    ...provider,
    clientId: clientId.length > 4 ? `••••${clientId.slice(-4)}` : "••••",
    // What the operator must register as the redirect URI at the IdP.
    callbackUrl: oauthCallbackUrl(await getPublicBaseUrl(), provider.id),
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireApiUser(request);
    const { id } = await params;
    const provider = await getOAuthProvider(id);
    if (!provider) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(await redactClientId(toOAuthProviderView(provider)), {
      headers: PRIVATE_RESPONSE_HEADERS,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();

    const existing = await getOAuthProvider(id);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Env-sourced providers can only have `enabled` toggled
    if (existing.source === "env") {
      const allowedKeys = ["enabled"];
      const bodyKeys = Object.keys(body).filter((k) => body[k] !== undefined);
      const disallowed = bodyKeys.filter((k) => !allowedKeys.includes(k));
      if (disallowed.length > 0) {
        return NextResponse.json(
          { error: `Environment-sourced providers can only update: ${allowedKeys.join(", ")}` },
          { status: 400 },
        );
      }
    }

    const updated = await updateOAuthProvider(id, body);
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    invalidateProviderCache();

    await createAuditEvent({
      userId,
      action: "update",
      entityType: "oauth_provider",
      entityId: null,
      summary: `Updated OAuth provider "${updated.name}"`,
      data: JSON.stringify({ providerId: updated.id, fields: Object.keys(body) }),
    });

    return NextResponse.json(await redactClientId(toOAuthProviderView(updated)), {
      headers: PRIVATE_RESPONSE_HEADERS,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await requireApiUser(request);
    const { id } = await params;

    const existing = await getOAuthProvider(id);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (existing.source === "env") {
      return NextResponse.json(
        { error: "Cannot delete an environment-sourced OAuth provider" },
        { status: 400 },
      );
    }

    await deleteOAuthProvider(id);

    invalidateProviderCache();

    await createAuditEvent({
      userId,
      action: "delete",
      entityType: "oauth_provider",
      entityId: null,
      summary: `Deleted OAuth provider "${existing.name}"`,
      data: JSON.stringify({ providerId: existing.id, name: existing.name }),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
