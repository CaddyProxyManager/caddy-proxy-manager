import { localUsersDisabled } from "@/src/lib/auth-policy";
import { auth } from "@/src/lib/auth";
import { getProviderDisplayList } from "@/src/lib/models/oauth-providers";
import { listLdapDirectoryChoices } from "@/src/lib/models/ldap-directories";
import {
  isForwardAuthDomain,
  createRedirectIntent,
  getDisallowedForwardAuthPort,
  redirectIntentWantsCaptcha,
} from "@/src/lib/models/forward-auth";
import { getActiveCaptcha } from "@/src/lib/captcha/settings";
import { cspNonce } from "@/src/lib/csp";
import PortalLoginForm from "./PortalLoginForm";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { oauthCallbackErrorMessage } from "@/src/lib/oauth-callback-error";
import { headers } from "next/headers";
import { getClientIp } from "@/src/lib/client-ip";
import { takeFromWindow } from "@/src/lib/rate-limit";

/** A person opens a handful of protected tabs in ten minutes; a GET loop opens thousands. */
const INTENTS_PER_CLIENT = 30;
const INTENT_WINDOW_MS = 10 * 60_000;

interface PortalPageProps {
  /** `error` is set by Better Auth when a single sign-on attempt comes back refused. */
  searchParams: Promise<{
    rd?: string | string[];
    rid?: string | string[];
    error?: string | string[];
  }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return {
    // Absolute: the portal fronts other people's apps, so it does not
    // announce the product in the tab title the way the dashboard does.
    title: { absolute: t("authenticationRequired") },
  };
}

export default async function PortalPage({ searchParams }: PortalPageProps) {
  const params = await searchParams;
  // CPM never repeats one, so a repeated parameter is refused rather than resolved by picking.
  const repeatedParam = Array.isArray(params.rd) || Array.isArray(params.rid);
  const redirectUri = typeof params.rd === "string" ? params.rd : "";
  // After OAuth callback, the portal is loaded with ?rid= (the opaque ID we created earlier)
  const existingRid = typeof params.rid === "string" ? params.rid : "";

  // Two entry modes:
  // 1. Fresh from Caddy redirect: ?rd=<full-url> → validate, store server-side, create rid
  // 2. Returning from OAuth: ?rid=<opaque-id> → reuse the existing rid (redirect already stored)
  // A Caddy redirect always carries ?rd=, so a ?rid= beside it came from the protected URL's own
  // query string and must not replace the target the browser was sent from.
  let targetDomain = "";
  let disallowedPort: string | null = null;
  let rid = redirectUri || repeatedParam ? "" : existingRid;
  if (!rid && redirectUri && !repeatedParam) {
    try {
      const parsed = new URL(redirectUri);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        (await isForwardAuthDomain(parsed.hostname))
      ) {
        targetDomain = parsed.hostname;
        // Every GET writes a row, so each client gets a budget; past it the portal shows its
        // generic message rather than another intent.
        const ip = (await getClientIp(await headers())) ?? "unknown";
        // A form that could only fail is replaced by the reason.
        disallowedPort = await getDisallowedForwardAuthPort(redirectUri);
        if (
          !disallowedPort &&
          takeFromWindow(`portal-intent:${ip}`, INTENTS_PER_CLIENT, INTENT_WINDOW_MS)
        ) {
          // Store the redirect URI server-side. The client only gets an opaque ID,
          // so a tampered ?rd= parameter cannot influence the final redirect target.
          rid = await createRedirectIntent(redirectUri);
        }
      }
    } catch {
      // invalid URL - portal will show a generic message
    }
  }

  const [session, enabledProviders, directories, t, tAuth] = await Promise.all([
    auth(),
    getProviderDisplayList(),
    listLdapDirectoryChoices(),
    getTranslations("auth.login"),
    getTranslations("auth"),
  ]);
  const oauthError = oauthCallbackErrorMessage(
    typeof params.error === "string" ? params.error : undefined,
    t,
  );
  const errorMessage = repeatedParam
    ? tAuth("portalInvalidLink")
    : disallowedPort
      ? tAuth("portalPortNotAllowed", { port: disallowedPort })
      : null;
  const localLoginEnabled = !(await localUsersDisabled());
  // Per host: an operator can switch it off for one whose users cannot solve it.
  const configured =
    (localLoginEnabled || directories.length > 0) && rid ? await getActiveCaptcha() : null;
  const captcha = configured && (await redirectIntentWantsCaptcha(rid)) ? configured : null;

  return (
    <PortalLoginForm
      rid={rid}
      initialError={oauthError}
      hasRedirect={!!redirectUri || !!existingRid || repeatedParam}
      targetDomain={targetDomain}
      errorMessage={errorMessage}
      enabledProviders={enabledProviders}
      localLoginEnabled={localLoginEnabled}
      directories={directories}
      captcha={captcha}
      cspNonce={captcha ? cspNonce((await headers()).get("Content-Security-Policy")) : undefined}
      existingSession={
        session
          ? {
              userId: session.user.id,
              name: session.user.name ?? null,
              email: session.user.email ?? null,
            }
          : null
      }
    />
  );
}
