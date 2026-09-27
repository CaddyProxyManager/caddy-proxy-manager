"use server";

/**
 * Each action re-checks the stage before writing: a page guard is only a redirect, and these are
 * what create an administrator, so an unauthenticated POST could otherwise mint one.
 */
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { extractErrorMessage } from "@/src/lib/actions";
import { createOAuthProvider } from "@/src/lib/models/oauth-providers";
import { createUser, findUserByEmail } from "@/src/lib/models/user";
import { hashPassword } from "@/src/lib/password";
import { passwordPolicyMessage } from "@/src/lib/password-policy-message";
import {
  SETUP_ACCOUNT_CLAIM,
  claimSetupStep,
  hasAnySignIn,
  isSetupCompleted,
  releaseSetupStep,
} from "@/src/lib/setup";

export type SetupActionState = { error: string | null };

/** `hasAnySignIn`, not the completion flag, which would leave this open for the rest of setup. */
async function assertAccountStepOpen(): Promise<void> {
  if ((await isSetupCompleted()) || (await hasAnySignIn())) {
    const t = await getTranslations("setup.errors");
    throw new Error(t("alreadyCompleted"));
  }
}

/**
 * Runs `create` holding the account step's claim, re-checking the step under it, so two setup
 * requests can't both see an empty instance. Returns an error message, or null once created.
 */
async function withAccountStep(create: () => Promise<string | null>): Promise<string | null> {
  const t = await getTranslations("setup.errors");
  const claim = await claimSetupStep(SETUP_ACCOUNT_CLAIM);
  if (!claim) return t("alreadyCompleted");
  try {
    await assertAccountStepOpen();
    return await create();
  } catch (error) {
    return extractErrorMessage(await getTranslations(), error, t("noLongerOpen"));
  } finally {
    await releaseSetupStep(SETUP_ACCOUNT_CLAIM, claim);
  }
}

/** Create the first administrator from the setup form. */
export async function createFirstAdmin(
  _previous: SetupActionState,
  formData: FormData,
): Promise<SetupActionState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("passwordConfirmation") ?? "");

  const t = await getTranslations();

  if (!username) return { error: t("setup.errors.usernameRequired") };
  if (password !== confirmation) return { error: t("setup.errors.passwordsDiffer") };

  const policyFailure = passwordPolicyMessage(t, password, t("passwordPolicy.subject.password"));
  if (policyFailure) return { error: policyFailure };

  // Hashed before the claim, so the slow part doesn't hold it.
  const passwordHash = await hashPassword(password);
  // The same synthetic address the environment-seeded admin has always used, so an operator who
  // later sets ADMIN_USERNAME to the same name updates this account rather than making a second.
  const email = `${username.toLowerCase()}@localhost`;
  const failure = await withAccountStep(async () => {
    if (await findUserByEmail(email)) return t("setup.errors.usernameTaken");
    await createUser({
      email,
      name: username,
      role: "admin",
      provider: "credentials",
      subject: username,
      username: username.toLowerCase(),
      displayUsername: username,
      passwordHash,
    });
    return null;
  });
  if (failure) return { error: failure };

  // To the login page rather than onwards: the point of this step is to prove the credentials work
  // before any more configuration is entered.
  redirect("/login");
}

/** Configure an OAuth provider as the way in, instead of a local account. */
export async function configureFirstOAuthProvider(
  _previous: SetupActionState,
  formData: FormData,
): Promise<SetupActionState> {
  const name = String(formData.get("providerName") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();
  const issuer = String(formData.get("issuer") ?? "").trim();

  const t = await getTranslations("setup.errors");

  if (!name) return { error: t("displayNameRequired") };
  if (!clientId || !clientSecret) return { error: t("clientIdAndSecretRequired") };
  if (!/^https?:\/\/\S+$/.test(issuer)) {
    return { error: t("issuerMustBeUrl") };
  }

  const failure = await withAccountStep(async () => {
    try {
      await createOAuthProvider({
        name,
        type: "oidc",
        clientId,
        clientSecret,
        issuer,
        scopes: "openid email profile",
        autoLink: false,
        enabled: true,
        source: "ui",
      });
      return null;
    } catch (error) {
      console.error("Setup: failed to create the OAuth provider", error);
      return t("providerSaveFailed");
    }
  });
  if (failure) return { error: failure };

  redirect("/login");
}
