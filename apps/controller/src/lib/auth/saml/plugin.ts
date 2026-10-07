/**
 * SAML sign-in through @better-auth/sso. CPM writes the providers itself (models/saml-providers.ts),
 * so of the plugin's routes only sign-in, the assertion consumer and the SP metadata stay reachable;
 * the rest would let any signed-in user register an identity provider.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { sso } from "@better-auth/sso";
import { and, eq } from "drizzle-orm";
import db from "../../db";
import { oauthProviders } from "../../db/schema";
import { claimNonce } from "../../cluster/nonces";
import { provisionSamlUser } from "./provision";
import { readResponseFacts } from "./response-checks";
import { SAML_PROVIDER_TYPE } from "./urls";

/** Exact paths, for `disabledPaths`; the parameterised ones are refused by `guardSsoRequest`. */
export const SSO_DISABLED_PATHS = [
  "/sso/register",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
  "/sso/callback",
];

export const SAML_SIGN_IN_PATH = "/sign-in/sso";
export const SAML_ACS_PATH = "/sso/saml2/sp/acs/:providerId";
const SP_METADATA_PATH = "/sso/saml2/sp/metadata";

/**
 * What an assertion must satisfy beyond a valid signature. Audience, recipient and InResponseTo
 * are checked by the plugin unconditionally; `tests/integration/auth/saml-assertions.test.ts` is
 * what proves all of it.
 */
export const SAML_SECURITY = {
  // Its default is five minutes.
  clockSkew: 120_000,
  requireTimestamps: true,
  algorithms: { onDeprecated: "reject" as const },
  allowIdpInitiated: false,
  enableInResponseToValidation: true,
};

export function samlSignIn(options: { allowRegistration: boolean }): BetterAuthPlugin {
  return sso({
    modelName: "ssoProviders",
    // Registration goes through Settings only; the route is disabled as well.
    providersLimit: 0,
    disableImplicitSignUp: !options.allowRegistration,
    // A provider's `domain` is what CPM's administrators vouch for; CPM writes it verified.
    domainVerification: { enabled: true },
    provisionUser: provisionSamlUser,
    provisionUserOnEveryLogin: true,
    saml: SAML_SECURITY,
  }) as unknown as BetterAuthPlugin;
}

async function samlProvider(providerId: unknown, enabledOnly = true): Promise<boolean> {
  if (typeof providerId !== "string" || !providerId) return false;
  const [row] = await db
    .select({ enabled: oauthProviders.enabled })
    .from(oauthProviders)
    .where(and(eq(oauthProviders.id, providerId), eq(oauthProviders.type, SAML_PROVIDER_TYPE)))
    .limit(1);
  return Boolean(row) && (!enabledOnly || row.enabled);
}

type GuardContext = {
  path: string;
  context: { baseURL: string };
  body?: unknown;
  params?: Record<string, string | undefined> | null;
  query?: Record<string, unknown> | null;
};

/** To the sign-in page, as the plugin answers a refused response. */
function refuseResponse(ctx: GuardContext, error: string): never {
  const url = new URL("/login", new URL(ctx.context.baseURL).origin);
  url.searchParams.set("error", error);
  throw new APIError("FOUND", undefined, { Location: url.toString() });
}

async function checkResponse(ctx: GuardContext, providerId: string): Promise<void> {
  const body =
    ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : null;
  const facts = readResponseFacts(body?.SAMLResponse, SAML_SECURITY.clockSkew);
  if (!facts) return;
  if (!facts.strongAlgorithms) refuseResponse(ctx, "deprecated_algorithm");
  // Claimed before the plugin verifies it: a forged copy can burn an ID only by having seen it,
  // and whoever has seen a valid assertion could have replayed it anyway.
  if (
    facts.assertionId &&
    !(await claimNonce(`saml-assertion:${providerId}:${facts.assertionId}`, facts.rememberUntil))
  ) {
    refuseResponse(ctx, "replay_detected");
  }
}

function notFound(): never {
  throw new APIError("NOT_FOUND", { message: "Not found" });
}

/** Whether a path is the plugin's; the caller runs this before its other guards. */
export function isSsoPath(path: string): boolean {
  return path === SAML_SIGN_IN_PATH || path.startsWith("/sso/");
}

/** For `hooks.before`: a disabled provider is as gone as a deleted one, at every step. */
export async function guardSsoRequest(ctx: GuardContext): Promise<void> {
  if (ctx.path === SAML_SIGN_IN_PATH) {
    const body =
      ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : null;
    if (!body || !(await samlProvider(body.providerId))) notFound();
    // By provider id only: an email or domain lookup would pick a provider the caller named
    // indirectly, and `requestSignUp` would bypass the registration setting.
    for (const key of ["email", "domain", "organizationSlug", "requestSignUp", "loginHint"]) {
      delete body[key];
    }
    body.providerType = "saml";
    return;
  }
  if (ctx.path === SAML_ACS_PATH) {
    const providerId = ctx.params?.providerId;
    if (!(await samlProvider(providerId))) notFound();
    await checkResponse(ctx, String(providerId));
    return;
  }
  if (ctx.path === SP_METADATA_PATH) {
    // A disabled provider's too: it is registered with the identity provider before it is on.
    if (!(await samlProvider(ctx.query?.providerId, false))) notFound();
    return;
  }
  if (ctx.path.startsWith("/sso/")) notFound();
}
