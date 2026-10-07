import { authClient } from "@/src/lib/auth/client";

/**
 * Off to the provider. OIDC goes through the auth client; SAML through the plugin's route, which
 * answers with the identity provider's URL rather than redirecting, so the page follows it.
 */
export async function startProviderSignIn(
  provider: { id: string; protocol?: "oidc" | "saml" },
  urls: { callbackURL: string; errorCallbackURL: string },
): Promise<void> {
  if (provider.protocol !== "saml") {
    await authClient.signIn.social({ provider: provider.id, ...urls });
    return;
  }
  const response = await fetch("/api/auth/sign-in/sso", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: provider.id, ...urls }),
  });
  const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (!response.ok || typeof body?.url !== "string") throw new Error("SAML sign-in refused");
  window.location.assign(body.url);
}
