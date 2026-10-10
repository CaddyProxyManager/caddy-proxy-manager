"use client";

import { KeyRound, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { SignInIdentity } from "@/src/components/auth/SignInIdentity";
import {
  type DirectoryChoice,
  DirectorySelector,
  signInSource,
  useDirectoryChoice,
} from "@/src/components/auth/DirectorySelector";
import { type SignInProvider, SignInProviders } from "@/src/components/auth/SignInProviders";
import { startProviderSignIn } from "@/src/components/auth/provider-sign-in";
import { useCaptchaStep } from "@/src/components/auth/useCaptchaStep";
import { usePasskeySignIn } from "@/src/components/auth/usePasskeySignIn";
import { type TwoFactorSubmission, TwoFactorStep } from "@/src/components/auth/TwoFactorStep";
import {
  AUTOFILL_CURRENT_PASSWORD,
  AUTOFILL_USERNAME,
  AUTOFILL_USERNAME_WEBAUTHN,
  NO_SPELLCHECK,
} from "@/src/components/ui/native-input-attrs";
import { authClient } from "@/src/lib/auth/client";
import { APP_VERSION, appVersionLabel, PRODUCT_NAME } from "@/src/lib/runtime/app-version";
import type { CaptchaWidgetConfig } from "@/src/lib/captcha/providers";
import {
  SSO_REQUIRED,
  accountLockSeconds,
  lockLiftsIn,
  signInErrorMessage,
} from "@/src/lib/auth/sign-in-error";
import { twoFactorError } from "@/src/lib/auth/two-factor/error";
import { usePageFrame } from "@/src/components/ui/standalone-page";

interface LoginClientProps {
  enabledProviders: SignInProvider[];
  /** False in OIDC-only mode. */
  localLoginEnabled?: boolean;
  appName?: string;
  /** A refused SSO attempt, already translated by the page. */
  initialError?: string | null;
  /** Solved on the username step. */
  captcha?: CaptchaWidgetConfig | null;
  /** Cap needs it for the scripts it injects. */
  cspNonce?: string;
  /** Email is set up, so a forgotten password can be reset from here. */
  passwordResetEnabled?: boolean;
  /** Self-registration is on, so /login/sign-up is offered. */
  signUpEnabled?: boolean;
  /** Enabled LDAP directories: one is a silent fallback, several get a selector. */
  directories?: DirectoryChoice[];
  /** Passwords and passkeys then work only for break-glass accounts. */
  ssoEnforced?: boolean;
  /** Start the passkey autofill request on load; otherwise only the button starts one. */
  passkeyAutofill?: boolean;
}

export default function LoginClient({
  enabledProviders = [],
  localLoginEnabled = true,
  appName = PRODUCT_NAME,
  initialError = null,
  captcha = null,
  cspNonce,
  passwordResetEnabled = false,
  signUpEnabled = false,
  directories = [],
  ssoEnforced = false,
  passkeyAutofill = false,
}: LoginClientProps) {
  const frame = usePageFrame();
  const t = useTranslations("auth.login");
  const tCommon = useTranslations("common");
  const tAuth = useTranslations("auth");
  const tPasskey = useTranslations("auth.passkey");
  const tErrors = useTranslations("auth.errors");
  const tApi = useTranslations("auth.apiErrors");
  const format = useFormatter();
  const router = useRouter();
  const [loginError, setLoginError] = useState<string | null>(initialError);
  const [loginPending, setLoginPending] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [onPasswordStep, setOnPasswordStep] = useState(false);
  // The 2FA challenge lives in Better Auth's cookie; this only remembers it was asked for.
  const [onCodeStep, setOnCodeStep] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [directoryChoice, setDirectoryChoice] = useDirectoryChoice(directories, localLoginEnabled);
  // A directory takes passwords even when local accounts are off.
  const passwordFormEnabled = localLoginEnabled || directories.length > 0;
  const captchaStep = useCaptchaStep({ config: captcha, nonce: cspNonce, onError: setLoginError });
  // No CAPTCHA or second step: a passkey is both factors, and there is no name to guess against.
  const passkey = usePasskeySignIn({
    enabled: localLoginEnabled,
    autoFill: passkeyAutofill,
    onSignedIn: () => {
      router.replace("/");
      router.refresh();
    },
    onError: setLoginError,
  });

  // After the commit that unhides the field: focus() inside a `hidden` subtree is a no-op, and a
  // handler (or its rAF) can run before React removes the attribute.
  useEffect(() => {
    if (onPasswordStep) {
      passwordRef.current?.focus();
    }
  }, [onPasswordStep]);

  const signIn = async (trimmedUsername: string) => {
    setLoginPending(true);

    // usernameClient's inferred types fail to merge in some environments, and /sign-in/ldap is
    // reached through the client's path proxy, so cast a stable shape.
    type SignInResult = Promise<{
      data: { twoFactorRedirect?: boolean } | null;
      error: { status?: number; code?: string; message?: string; retryAfter?: unknown } | null;
    }>;
    const client = authClient.signIn as unknown as {
      username: (input: { username: string; password: string }) => SignInResult;
      ldap: (input: { username: string; password: string; directoryId?: string }) => SignInResult;
    };
    const source = signInSource(directories, directoryChoice);
    const { data, error } =
      source.kind === "local"
        ? await client.username({ username: trimmedUsername, password })
        : await client.ldap({
            username: trimmedUsername,
            password,
            ...(source.directoryId ? { directoryId: source.directoryId } : {}),
          });

    if (error?.code === "CAPTCHA_REQUIRED") {
      // The pass lapsed while typing; the widget returns on this step with the password kept.
      captchaStep.spent("expired");
      setLoginPending(false);
      return;
    }

    if (error) {
      // Any attempt spends the pass.
      captchaStep.spent();
      // By code: Better Auth's `message` is always English.
      const lockSeconds = accountLockSeconds(error);
      setLoginError(
        // Worded by the server, in the reader's language (auth/server.ts).
        error.code === SSO_REQUIRED && error.message
          ? error.message
          : lockSeconds === null
            ? signInErrorMessage(error, (key) => tErrors(key))
            : tErrors("accountLocked", { retry: lockLiftsIn(format, lockSeconds) }),
      );
      setLoginPending(false);
      // Keep the name on screen so a typo in it can be told from a wrong password.
      setOnPasswordStep(true);
      return;
    }

    if (data?.twoFactorRedirect) {
      setPassword("");
      setOnCodeStep(true);
      setLoginPending(false);
      return;
    }

    router.replace("/");
    router.refresh();
  };

  const startOver = () => {
    setOnCodeStep(false);
    setOnPasswordStep(false);
    setPassword("");
    captchaStep.spent();
  };

  const verifyCode = async ({ method, code, trustDevice }: TwoFactorSubmission) => {
    setLoginError(null);
    setLoginPending(true);
    const verify =
      method === "totp" ? authClient.twoFactor.verifyTotp : authClient.twoFactor.verifyBackupCode;
    const { error } = await verify({ code, trustDevice });
    if (error) {
      const refused = twoFactorError(error);
      setLoginError(tApi(refused.key));
      setLoginPending(false);
      if (refused.restart) startOver();
      return;
    }
    router.replace("/");
    router.refresh();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError(null);

    // Not FormData: Astryx drops `name` from disabled inputs, and these disable while pending.
    const trimmedUsername = username.trim();

    if (!trimmedUsername) {
      setLoginError(t("usernameRequired"));
      return;
    }

    // Advances for any username: resolving it would tell anyone whether the account exists.
    if (!onPasswordStep) {
      if (!(await captchaStep.pass(trimmedUsername))) return;
      // A password manager may have filled the hidden password already.
      if (!password) {
        setOnPasswordStep(true);
        return;
      }
    } else {
      if (!password) {
        setLoginError(t("passwordRequired"));
        return;
      }
      // After a failed attempt the widget is back on this step.
      if (!(await captchaStep.pass(trimmedUsername))) return;
    }

    await signIn(trimmedUsername);
  };

  const handleOAuthSignIn = async (provider: SignInProvider) => {
    setLoginError(null);
    setOauthPending(provider.id);
    try {
      // Otherwise a refused sign-in lands on Better Auth's bare error page.
      await startProviderSignIn(provider, { callbackURL: "/", errorCallbackURL: "/login" });
    } catch {
      setLoginError(t("oauthFailed"));
      setOauthPending(null);
    }
  };

  const disabled = loginPending || captchaStep.pending || !!oauthPending || passkey.pending;
  const hasProviders = enabledProviders.length > 0;

  const subtitle = !passwordFormEnabled
    ? t("subtitleSsoOnly")
    : onCodeStep
      ? t("subtitleCode")
      : onPasswordStep
        ? t("subtitlePassword")
        : t("subtitleIdentify");

  const providerList = (
    <SignInProviders
      providers={enabledProviders}
      pendingId={oauthPending}
      isDisabled={disabled}
      onSelect={handleOAuthSignIn}
    />
  );

  return (
    <Center role={frame.role} minHeight="100vh" padding={4}>
      <Card width={400}>
        <VStack gap={4}>
          <VStack gap={1} hAlign="center">
            <Heading level={frame.titleLevel}>{appName}</Heading>
            <Text type="body" size="sm" color="secondary">
              {subtitle}
            </Text>
          </VStack>

          {loginError && (
            <Banner status="error" title={tAuth("couldNotSignIn")} description={loginError} />
          )}

          {!passwordFormEnabled && !hasProviders && (
            <Banner
              status="error"
              title={tAuth("signInUnavailableTitle")}
              description={t("noMethodDescription")}
            />
          )}

          {ssoEnforced && passwordFormEnabled && (
            <Text type="supporting" color="secondary">
              {t("ssoEnforcedNotice")}
            </Text>
          )}

          {/* SSO only: the providers are the whole form. */}
          {!passwordFormEnabled && hasProviders && providerList}

          {passwordFormEnabled && onCodeStep && (
            <TwoFactorStep pending={loginPending} onSubmit={verifyCode} onCancel={startOver} />
          )}

          {passwordFormEnabled && !onCodeStep && (
            <>
              {/*
                One form with the password always mounted: password managers fill both fields at
                once, and cannot fill one that is not in the document yet.
              */}
              <form onSubmit={handleSubmit}>
                <VStack gap={3}>
                  {onPasswordStep ? (
                    <SignInIdentity
                      username={username.trim()}
                      isDisabled={disabled}
                      onChange={() => {
                        setOnPasswordStep(false);
                        setPassword("");
                        setLoginError(null);
                        captchaStep.spent();
                      }}
                    />
                  ) : (
                    <>
                      <TextInput
                        startIcon={User}
                        {...(passkeyAutofill ? AUTOFILL_USERNAME_WEBAUTHN : AUTOFILL_USERNAME)}
                        {...NO_SPELLCHECK}
                        label={tCommon("username")}
                        htmlName="username"
                        value={username}
                        onChange={setUsername}
                        isRequired
                        hasAutoFocus={frame.autoFocus}
                        isDisabled={disabled}
                        width="100%"
                      />
                      <DirectorySelector
                        directories={directories}
                        localLoginEnabled={localLoginEnabled}
                        value={directoryChoice}
                        onChange={setDirectoryChoice}
                        isDisabled={disabled}
                      />
                      {/* A pass is for one name only, so going back for another means a new solve. */}
                      {captchaStep.widget}
                    </>
                  )}
                  <div hidden={!onPasswordStep}>
                    <TextInput
                      startIcon={KeyRound}
                      {...AUTOFILL_CURRENT_PASSWORD}
                      ref={passwordRef}
                      label={tCommon("password")}
                      type="password"
                      htmlName="password"
                      value={password}
                      onChange={setPassword}
                      isRequired
                      isDisabled={disabled}
                      width="100%"
                    />
                  </div>
                  {onPasswordStep &&
                    passwordResetEnabled &&
                    !signInSource(directories, directoryChoice).directoryId && (
                      <Link href="/login/forgot-password" size="sm">
                        {t("forgotPassword")}
                      </Link>
                    )}
                  {/* Back after a failed attempt, which spent the last solve. */}
                  {onPasswordStep && captchaStep.widget}
                  <Button
                    type="submit"
                    variant="primary"
                    label={
                      loginPending
                        ? t("submitPending")
                        : onPasswordStep
                          ? t("submit")
                          : tCommon("continue")
                    }
                    isLoading={loginPending || captchaStep.pending}
                    isDisabled={disabled}
                    width="100%"
                  />
                </VStack>
              </form>

              {signUpEnabled && (
                <VStack hAlign="center">
                  <Link href="/login/sign-up" size="sm">
                    {t("createAccount")}
                  </Link>
                </VStack>
              )}

              {passkey.supported && (
                <Button
                  variant="secondary"
                  width="100%"
                  icon={<KeyRound />}
                  label={passkey.pending ? tPasskey("signingIn") : tPasskey("signIn")}
                  isLoading={passkey.pending}
                  isDisabled={disabled}
                  onClick={() => {
                    setLoginError(null);
                    void passkey.start();
                  }}
                />
              )}

              {hasProviders && (
                <>
                  <Divider label={t("ssoDivider")} />
                  {providerList}
                </>
              )}
            </>
          )}

          <VStack hAlign="center">
            <Text type="body" size="sm" color="secondary">
              {appVersionLabel(appName, tCommon("versionNumber", { version: APP_VERSION }))}
            </Text>
          </VStack>
        </VStack>
      </Card>
    </Center>
  );
}
