"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Shield, User } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
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
import { useCaptchaStep } from "@/src/components/auth/useCaptchaStep";
import { usePasskeySignIn } from "@/src/components/auth/usePasskeySignIn";
import { type TwoFactorSubmission, TwoFactorStep } from "@/src/components/auth/TwoFactorStep";
import { accountLockSeconds, lockLiftsIn } from "@/src/lib/auth/sign-in-error";
import {
  TWO_FACTOR_SETUP_PATH,
  TWO_FACTOR_SETUP_REQUIRED,
  twoFactorError,
} from "@/src/lib/auth/two-factor/error";
import type { CaptchaWidgetConfig } from "@/src/lib/captcha/providers";
import {
  AUTOFILL_CURRENT_PASSWORD,
  AUTOFILL_USERNAME_WEBAUTHN,
} from "@/components/ui/native-input-attrs";
import { authClient } from "@/src/lib/auth/client";
import { useFormatter, useTranslations } from "next-intl";
import { usePageFrame } from "@/src/components/ui/standalone-page";

interface PortalLoginFormProps {
  rid: string;
  hasRedirect: boolean;
  targetDomain: string;
  /** Why this sign-in cannot go ahead; shown in place of the form. */
  errorMessage?: string | null;
  enabledProviders?: SignInProvider[];
  /** False in OIDC-only mode. */
  localLoginEnabled?: boolean;
  existingSession?: { userId: string; name: string | null; email: string | null } | null;
  initialError?: string | null;
  /** Null when none is configured, or this host turned it off. */
  captcha?: CaptchaWidgetConfig | null;
  /** Cap needs it for the scripts it injects. */
  cspNonce?: string;
  /** As on /login: one is a silent fallback, several get a selector. */
  directories?: DirectoryChoice[];
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
  const frame = usePageFrame();
  return (
    <Center role={frame.role} minHeight="100vh" padding={4}>
      <Card width={400}>
        <VStack gap={4}>
          <VStack gap={1} hAlign="center">
            {hasShield && <Icon icon={Shield} size="lg" color="secondary" />}
            <Heading level={frame.titleLevel}>{title}</Heading>
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
  errorMessage = null,
  enabledProviders = [],
  localLoginEnabled = true,
  existingSession,
  initialError = null,
  captcha = null,
  cspNonce,
  directories = [],
}: PortalLoginFormProps) {
  const frame = usePageFrame();
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const tl = useTranslations("auth.login");
  const tPasskey = useTranslations("auth.passkey");
  const format = useFormatter();
  const [error, setError] = useState<string | null>(initialError);
  // The account must set up 2FA in the dashboard first, which the error banner links to.
  const [setupRequired, setSetupRequired] = useState(false);
  const [pending, setPending] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Two steps as on /login: the password is only asked for once there is a name to attach it to.
  const [onPasswordStep, setOnPasswordStep] = useState(false);
  // Issued by the password step for an account with 2FA; the code step sends it back.
  const [challenge, setChallenge] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [directoryChoice, setDirectoryChoice] = useDirectoryChoice(directories, localLoginEnabled);
  const passwordFormEnabled = localLoginEnabled || directories.length > 0;
  const captchaStep = useCaptchaStep({ config: captcha, nonce: cspNonce, onError: setError });

  // Focusing from the handler races React's commit (see LoginClient).
  useEffect(() => {
    if (onPasswordStep) {
      passwordRef.current?.focus();
    }
  }, [onPasswordStep]);

  // A dashboard session (OAuth's, or a passkey's) is exchanged for a forward auth one.
  const exchangeSession = useCallback(() => {
    setPending(true);
    setSetupRequired(false);
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
          setSetupRequired(data.code === TWO_FACTOR_SETUP_REQUIRED);
          setError(data.error ?? t("authorizeFailed"));
          setPending(false);
        }
      })
      .catch(() => {
        setError(t("unexpectedError"));
        setPending(false);
      });
    // `t` is stable per locale, so this does not change every render.
  }, [rid, t]);

  // An existing session gets a forward auth session without a form.
  useEffect(() => {
    if (existingSession && rid) exchangeSession();
  }, [existingSession, rid, exchangeSession]);

  // The portal is on the Public URL's origin, so the dashboard's passkeys work here too.
  const passkey = usePasskeySignIn({
    enabled: localLoginEnabled && hasRedirect && !errorMessage && !existingSession,
    onSignedIn: exchangeSession,
    onError: setError,
  });

  const submitCredentials = async (trimmedUsername: string) => {
    setPending(true);
    setSetupRequired(false);
    try {
      const response = await fetch("/api/forward-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: trimmedUsername,
          password,
          rid,
          directoryId: signInSource(directories, directoryChoice).directoryId,
        }),
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
        setSetupRequired(data.code === TWO_FACTOR_SETUP_REQUIRED);
        const lockSeconds = accountLockSeconds({ ...data, status: response.status });
        setError(
          lockSeconds === null
            ? (data.error ?? t("login.failed"))
            : t("errors.accountLocked", { retry: lockLiftsIn(format, lockSeconds) }),
        );
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

  const disabled = pending || captchaStep.pending || !!oauthPending || passkey.pending;
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

  if (errorMessage) {
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
        <Banner status="error" title={t("couldNotSignIn")} description={errorMessage} />
      </PortalCard>
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
      {error &&
        (setupRequired ? (
          <Banner
            status="warning"
            title={t("twoFactorSetupTitle")}
            description={error}
            endContent={
              <AstryxLink href={TWO_FACTOR_SETUP_PATH}>{tNav("mfaGraceAction")}</AstryxLink>
            }
          />
        ) : (
          <Banner status="error" title={t("couldNotSignIn")} description={error} />
        ))}

      {!passwordFormEnabled && !hasProviders && (
        <Banner
          status="error"
          title={t("signInUnavailableTitle")}
          description={t("missingProviderDescription")}
        />
      )}

      {!passwordFormEnabled && hasProviders && providerList}

      {passwordFormEnabled && challenge && (
        <TwoFactorStep
          pending={pending}
          allowTrustDevice={false}
          onSubmit={submitCode}
          onCancel={startOver}
        />
      )}

      {passwordFormEnabled && !challenge && (
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
                    startIcon={User}
                    {...AUTOFILL_USERNAME_WEBAUTHN}
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
                  {/* Mounted with the step, as on /login: a new name means a new solve. */}
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
                      : tCommon("continue")
                }
                isLoading={pending || captchaStep.pending}
                isDisabled={disabled}
                width="100%"
              />
            </VStack>
          </form>

          {passkey.supported && (
            <Button
              variant="secondary"
              width="100%"
              icon={<KeyRound />}
              label={passkey.pending ? tPasskey("signingIn") : tPasskey("signIn")}
              isLoading={passkey.pending}
              isDisabled={disabled}
              onClick={() => {
                setError(null);
                void passkey.start();
              }}
            />
          )}

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
