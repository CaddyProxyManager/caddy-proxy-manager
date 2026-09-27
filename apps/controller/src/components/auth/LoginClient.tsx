"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { SignInIdentity } from "@/src/components/auth/SignInIdentity";
import { type SignInProvider, SignInProviders } from "@/src/components/auth/SignInProviders";
import { useCaptchaStep } from "@/src/components/auth/useCaptchaStep";
import { type TwoFactorSubmission, TwoFactorStep } from "@/src/components/auth/TwoFactorStep";
import {
  AUTOFILL_CURRENT_PASSWORD,
  AUTOFILL_USERNAME,
  NO_SPELLCHECK,
} from "@/src/components/ui/native-input-attrs";
import { authClient } from "@/src/lib/auth-client";
import { formatAppVersion } from "@/src/lib/app-version";
import type { CaptchaWidgetConfig } from "@/src/lib/captcha/providers";
import { signInErrorMessage } from "@/src/lib/sign-in-error";
import { twoFactorError } from "@/src/lib/two-factor-error";

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
}

export default function LoginClient({
  enabledProviders = [],
  localLoginEnabled = true,
  appName = "Caddy Proxy Manager",
  initialError = null,
  captcha = null,
  cspNonce,
}: LoginClientProps) {
  const t = useTranslations("auth.login");
  const tErrors = useTranslations("auth.errors");
  const tApi = useTranslations("auth.apiErrors");
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
  const captchaStep = useCaptchaStep({ config: captcha, nonce: cspNonce, onError: setLoginError });

  // After the commit that unhides the field: focus() inside a `hidden` subtree is a no-op, and a
  // handler (or its rAF) can run before React removes the attribute.
  useEffect(() => {
    if (onPasswordStep) {
      passwordRef.current?.focus();
    }
  }, [onPasswordStep]);

  const signIn = async (trimmedUsername: string) => {
    setLoginPending(true);

    // usernameClient's inferred types fail to merge in some environments, so cast a stable shape.
    type SignInUsername = (input: { username: string; password: string }) => Promise<{
      data: { twoFactorRedirect?: boolean } | null;
      error: { status?: number; code?: string; message?: string } | null;
    }>;
    const signInUsername = (authClient.signIn as unknown as { username: SignInUsername }).username;
    const { data, error } = await signInUsername({ username: trimmedUsername, password });

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
      setLoginError(signInErrorMessage(error, (key) => tErrors(key)));
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

  const handleOAuthSignIn = async (providerId: string) => {
    setLoginError(null);
    setOauthPending(providerId);
    try {
      // Otherwise a refused sign-in lands on Better Auth's bare error page.
      await authClient.signIn.social({
        provider: providerId,
        callbackURL: "/",
        errorCallbackURL: "/login",
      });
    } catch {
      setLoginError(t("oauthFailed"));
      setOauthPending(null);
    }
  };

  const disabled = loginPending || captchaStep.pending || !!oauthPending;
  const hasProviders = enabledProviders.length > 0;

  const subtitle = !localLoginEnabled
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
    <Center minHeight="100vh" padding={4}>
      <Card width={400}>
        <VStack gap={4}>
          <VStack gap={1} hAlign="center">
            <Heading level={1}>{appName}</Heading>
            <Text type="body" size="sm" color="secondary">
              {subtitle}
            </Text>
          </VStack>

          {loginError && <Banner status="error" title={t("errorTitle")} description={loginError} />}

          {!localLoginEnabled && !hasProviders && (
            <Banner
              status="error"
              title={t("noMethodTitle")}
              description={t("noMethodDescription")}
            />
          )}

          {/* SSO only: the providers are the whole form. */}
          {!localLoginEnabled && hasProviders && providerList}

          {localLoginEnabled && onCodeStep && (
            <TwoFactorStep pending={loginPending} onSubmit={verifyCode} onCancel={startOver} />
          )}

          {localLoginEnabled && !onCodeStep && (
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
                        {...AUTOFILL_USERNAME}
                        {...NO_SPELLCHECK}
                        label={t("username")}
                        htmlName="username"
                        value={username}
                        onChange={setUsername}
                        isRequired
                        hasAutoFocus
                        isDisabled={disabled}
                        width="100%"
                      />
                      {/* A pass is for one name only, so going back for another means a new solve. */}
                      {captchaStep.widget}
                    </>
                  )}
                  <div hidden={!onPasswordStep}>
                    <TextInput
                      {...AUTOFILL_CURRENT_PASSWORD}
                      ref={passwordRef}
                      label={t("password")}
                      type="password"
                      htmlName="password"
                      value={password}
                      onChange={setPassword}
                      isRequired
                      isDisabled={disabled}
                      width="100%"
                    />
                  </div>
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
                          : t("continueStep")
                    }
                    isLoading={loginPending || captchaStep.pending}
                    isDisabled={disabled}
                    width="100%"
                  />
                </VStack>
              </form>

              {hasProviders && (
                <>
                  <Divider label={t("ssoDivider")} />
                  {providerList}
                </>
              )}
            </>
          )}

          <VStack hAlign="center">
            <Text type="body" size="xsm" color="secondary">
              {formatAppVersion()}
            </Text>
          </VStack>
        </VStack>
      </Card>
    </Center>
  );
}
