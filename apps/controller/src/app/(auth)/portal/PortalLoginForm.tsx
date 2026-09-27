"use client";

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Shield } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { SignInIdentity } from "@/src/components/auth/SignInIdentity";
import { type SignInProvider, SignInProviders } from "@/src/components/auth/SignInProviders";
import { useCaptchaStep } from "@/src/components/auth/useCaptchaStep";
import { type TwoFactorSubmission, TwoFactorStep } from "@/src/components/auth/TwoFactorStep";
import { twoFactorError } from "@/src/lib/two-factor-error";
import type { CaptchaWidgetConfig } from "@/src/lib/captcha/providers";
import { AUTOFILL_CURRENT_PASSWORD, AUTOFILL_USERNAME } from "@/components/ui/native-input-attrs";
import { authClient } from "@/src/lib/auth-client";
import { useTranslations } from "next-intl";

interface PortalLoginFormProps {
  rid: string;
  hasRedirect: boolean;
  targetDomain: string;
  enabledProviders?: SignInProvider[];
  /** False in OIDC-only mode. */
  localLoginEnabled?: boolean;
  existingSession?: { userId: string; name: string | null; email: string | null } | null;
  initialError?: string | null;
  /** Null when none is configured, or this host turned it off. */
  captcha?: CaptchaWidgetConfig | null;
  /** Cap needs it for the scripts it injects. */
  cspNonce?: string;
}

function PortalCard({
  title,
  description,
  hasShield = true,
  children,
}: {
  title: string;
  description: ReactNode;
  hasShield?: boolean;
  children?: ReactNode;
}) {
  return (
    <Center minHeight="100vh" padding={4}>
      <Card width={400}>
        <VStack gap={4}>
          <VStack gap={1} hAlign="center">
            {hasShield && <Icon icon={Shield} size="lg" color="secondary" />}
            <Heading level={1}>{title}</Heading>
            <Text type="body" size="sm" color="secondary" justify="center">
              {description}
            </Text>
          </VStack>
          {children}
        </VStack>
      </Card>
    </Center>
  );
}

export default function PortalLoginForm({
  rid,
  hasRedirect,
  targetDomain,
  enabledProviders = [],
  localLoginEnabled = true,
  existingSession,
  initialError = null,
  captcha = null,
  cspNonce,
}: PortalLoginFormProps) {
  const t = useTranslations("auth");
  const tl = useTranslations("auth.login");
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Two steps as on /login: the password is only asked for once there is a name to attach it to.
  const [onPasswordStep, setOnPasswordStep] = useState(false);
  // Issued by the password step for an account with 2FA; the code step sends it back.
  const [challenge, setChallenge] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const captchaStep = useCaptchaStep({ config: captcha, nonce: cspNonce, onError: setError });

  // Focusing from the handler races React's commit (see LoginClient).
  useEffect(() => {
    if (onPasswordStep) {
      passwordRef.current?.focus();
    }
  }, [onPasswordStep]);

  // An existing session (e.g. from OAuth) gets a forward auth session without a form.
  useEffect(() => {
    if (existingSession && rid) {
      setPending(true);
      fetch("/api/forward-auth/session-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rid }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.redirectTo) {
            window.location.href = data.redirectTo;
          } else {
            setError(data.error ?? t("authorizeFailed"));
            setPending(false);
          }
        })
        .catch(() => {
          setError(t("unexpectedError"));
          setPending(false);
        });
    }
    // `t` is stable per locale, so this does not re-run every render.
  }, [existingSession, rid, t]);

  const submitCredentials = async (trimmedUsername: string) => {
    setPending(true);
    try {
      const response = await fetch("/api/forward-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: trimmedUsername, password, rid }),
      });

      const data = await response.json();

      if (data.code === "CAPTCHA_REQUIRED") {
        // See LoginClient: the pass lapsed, so solve again on this step and keep the password.
        captchaStep.spent("expired");
        setPending(false);
        return;
      }

      if (!response.ok) {
        captchaStep.spent();
        setError(data.error ?? t("login.failed"));
        setPending(false);
        // So the name that failed is still readable.
        setOnPasswordStep(true);
        return;
      }

      if (data.needsSecondFactor) {
        setChallenge(data.challenge);
        setPassword("");
        setPending(false);
        return;
      }

      window.location.href = data.redirectTo;
    } catch {
      // Whether it reached the server is unknown, so assume the pass went with it.
      captchaStep.spent();
      setError(t("unexpectedErrorTryAgain"));
      setPending(false);
      setOnPasswordStep(true);
    }
  };

  const startOver = () => {
    setChallenge(null);
    setOnPasswordStep(false);
    setPassword("");
    captchaStep.spent();
  };

  const submitCode = async ({ method, code }: TwoFactorSubmission) => {
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/forward-auth/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge, rid, code, method }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? t("login.failed"));
        setPending(false);
        if (twoFactorError({ status: response.status, code: data.code }).restart) startOver();
        return;
      }
      window.location.href = data.redirectTo;
    } catch {
      setError(t("unexpectedErrorTryAgain"));
      setPending(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    // Not FormData: Astryx withholds a disabled input's `name`, and these disable while pending.
    const trimmedUsername = username.trim();

    if (!trimmedUsername) {
      setError(tl("usernameRequired"));
      return;
    }

    // Step one advances whether or not the account exists - see LoginClient for why.
    if (!onPasswordStep) {
      if (!(await captchaStep.pass(trimmedUsername))) return;
      if (!password) {
        setOnPasswordStep(true);
        return;
      }
    } else {
      if (!password) {
        setError(tl("passwordRequired"));
        return;
      }
      if (!(await captchaStep.pass(trimmedUsername))) return;
    }

    await submitCredentials(trimmedUsername);
  };

  const handleOAuthSignIn = (providerId: string) => {
    setError(null);
    setOauthPending(providerId);
    // rid is an opaque server-side id; the real redirect URI is never in the URL.
    const callbackUrl = `/portal?rid=${encodeURIComponent(rid)}`;
    // A refused sign-in comes back to the same portal page, rid intact, so it can say why.
    authClient.signIn.social({
      provider: providerId,
      callbackURL: callbackUrl,
      errorCallbackURL: callbackUrl,
    });
  };

  const disabled = pending || captchaStep.pending || !!oauthPending;
  const hasProviders = enabledProviders.length > 0;

  if (!hasRedirect) {
    return (
      <PortalCard
        title={t("authenticationRequired")}
        description={t("missingDestinationDescription")}
        hasShield={false}
      />
    );
  }

  if (existingSession && pending && !error) {
    return (
      <PortalCard
        title={t("authorizing")}
        description={t("signingInAs", {
          account: existingSession.name ?? existingSession.email ?? "",
        })}
      />
    );
  }

  const providerList = (
    <SignInProviders
      providers={enabledProviders}
      pendingId={oauthPending}
      isDisabled={disabled}
      onSelect={handleOAuthSignIn}
    />
  );

  return (
    <PortalCard
      title={t("authenticationRequired")}
      description={
        targetDomain
          ? t.rich("signInToAccess", {
              host: targetDomain,
              host_: (chunks) => <strong>{chunks}</strong>,
            })
          : t("signInToContinue")
      }
    >
      {error && <Banner status="error" title={t("couldNotSignIn")} description={error} />}

      {!localLoginEnabled && !hasProviders && (
        <Banner
          status="error"
          title={t("signInUnavailableTitle")}
          description={t("missingProviderDescription")}
        />
      )}

      {!localLoginEnabled && hasProviders && providerList}

      {localLoginEnabled && challenge && (
        <TwoFactorStep
          pending={pending}
          allowTrustDevice={false}
          onSubmit={submitCode}
          onCancel={startOver}
        />
      )}

      {localLoginEnabled && !challenge && (
        <>
          {/* One form across both steps - see LoginClient for why the password field stays
              mounted while it is hidden. */}
          <form onSubmit={handleSubmit}>
            <VStack gap={3}>
              {onPasswordStep ? (
                <SignInIdentity
                  username={username.trim()}
                  isDisabled={disabled}
                  onChange={() => {
                    setOnPasswordStep(false);
                    setPassword("");
                    setError(null);
                    captchaStep.spent();
                  }}
                />
              ) : (
                <>
                  <TextInput
                    {...AUTOFILL_USERNAME}
                    label={t("username")}
                    htmlName="username"
                    value={username}
                    onChange={setUsername}
                    isRequired
                    hasAutoFocus
                    isDisabled={disabled}
                    width="100%"
                  />
                  {/* Mounted with the step, as on /login: a new name means a new solve. */}
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
                  pending
                    ? t("login.submitPending")
                    : onPasswordStep
                      ? t("login.submit")
                      : tl("continueStep")
                }
                isLoading={pending || captchaStep.pending}
                isDisabled={disabled}
                width="100%"
              />
            </VStack>
          </form>

          {hasProviders && (
            <>
              <Divider label={tl("ssoDivider")} />
              {providerList}
            </>
          )}
        </>
      )}
    </PortalCard>
  );
}
