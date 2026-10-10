import { localUsersDisabled, selfRegistrationOpen } from "@/src/lib/auth/policy";
import { getAppName } from "@/src/lib/branding/app-name";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getActiveCaptcha } from "@/src/lib/captcha/settings";
import { cspNonce } from "@/src/lib/http/csp";
import { auth } from "@/src/lib/auth";
import { getProviderDisplayList } from "@/src/lib/models/oauth-providers";
import { listLdapDirectoryChoices } from "@/src/lib/models/ldap-directories";
import LoginClient from "@/src/components/auth/LoginClient";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { oauthCallbackErrorMessage } from "@/src/lib/auth/oauth-callback-error";
import { emailReady } from "@/src/lib/email/config";
import { getSsoEnforcement } from "@/src/lib/auth/sso-break-glass";
import { passkeyAutofill } from "@/src/lib/settings/registry";
import { getSetting } from "@/src/lib/settings/resolve";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.login");
  return { title: t("metaTitle") };
}

interface LoginPageProps {
  /** Set by Better Auth when a single sign-on attempt comes back refused. */
  searchParams: Promise<{ error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [session, enabledProviders, directories, t, params] = await Promise.all([
    auth(),
    getProviderDisplayList(),
    listLdapDirectoryChoices(),
    getTranslations("auth.login"),
    searchParams,
  ]);
  if (session) {
    redirect("/");
  }

  const oauthError = oauthCallbackErrorMessage(params.error, t);
  const localLoginEnabled = !(await localUsersDisabled());
  // No local accounts and no directory, no username step to put it on.
  const captcha = localLoginEnabled || directories.length > 0 ? await getActiveCaptcha() : null;

  return (
    <LoginClient
      enabledProviders={enabledProviders}
      localLoginEnabled={localLoginEnabled}
      appName={await getAppName()}
      initialError={oauthError}
      captcha={captcha}
      passwordResetEnabled={localLoginEnabled && (await emailReady())}
      signUpEnabled={await selfRegistrationOpen()}
      directories={directories}
      ssoEnforced={(await getSsoEnforcement()).enforced}
      passkeyAutofill={await getSetting(passkeyAutofill)}
      cspNonce={captcha ? cspNonce((await headers()).get("Content-Security-Policy")) : undefined}
    />
  );
}
