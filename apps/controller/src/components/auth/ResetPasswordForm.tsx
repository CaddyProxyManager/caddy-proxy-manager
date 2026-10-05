"use client";

import { KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { PasswordPolicyChecklist } from "@/src/components/auth/PasswordPolicyChecklist";
import { SignInIdentity } from "@/src/components/auth/SignInIdentity";
import { AUTOFILL_NEW_PASSWORD, AUTOFILL_USERNAME } from "@/src/components/ui/native-input-attrs";
import { passwordPolicyMessage } from "@/src/lib/auth/password/policy-message";

type EmailedLink = { purpose: "reset" | "invite"; username: string };
type Stage =
  | { kind: "checking" }
  | { kind: "invalid" }
  | { kind: "form"; token: string; link: EmailedLink }
  | { kind: "done"; purpose: EmailedLink["purpose"] };

/** The token arrives in the fragment, which no server sees; it is dropped from the address bar. */
export default function ResetPasswordForm({ canRequestAnother }: { canRequestAnother: boolean }) {
  const t = useTranslations();
  const [stage, setStage] = useState<Stage>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const token = window.location.hash.replace(/^#/, "");
    if (!token) {
      setStage({ kind: "invalid" });
      return;
    }
    // Out of history and off the screen, for whoever uses the browser next.
    window.history.replaceState(null, "", window.location.pathname);
    let cancelled = false;
    void fetch("/api/password-reset/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setStage({ kind: "invalid" });
          return;
        }
        setStage({ kind: "form", token, link: (await response.json()) as EmailedLink });
      })
      .catch(() => {
        if (!cancelled) setStage({ kind: "invalid" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isMismatch = confirm.length > 0 && confirm !== password;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (stage.kind !== "form") return;
    setError(null);
    if (password !== confirm) {
      setError(t("auth.passwordChange.mismatch"));
      return;
    }
    const policyError = passwordPolicyMessage(t, password, t("passwordPolicy.subject.newPassword"));
    if (policyError) {
      setError(policyError);
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: stage.token, password }),
      });
      const data = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
      if (response.ok) {
        setStage({ kind: "done", purpose: stage.link.purpose });
        return;
      }
      if (data.code === "INVALID_LINK") {
        setStage({ kind: "invalid" });
        return;
      }
      setError(data.error ?? t("auth.passwordReset.failed"));
    } catch {
      setError(t("auth.passwordReset.failed"));
    } finally {
      setPending(false);
    }
  }

  const invite =
    (stage.kind === "form" && stage.link.purpose === "invite") ||
    (stage.kind === "done" && stage.purpose === "invite");

  return (
    <Center role="main" minHeight="100vh" padding={4} className="cpm-auth-page">
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 400 }}>
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={1}>
              {invite ? t("auth.passwordReset.inviteHeading") : t("auth.passwordReset.heading")}
            </Heading>
            {stage.kind === "form" && (
              <Text type="body" size="sm" color="secondary">
                {invite ? t("auth.passwordReset.inviteSubtitle") : t("auth.passwordReset.subtitle")}
              </Text>
            )}
          </VStack>

          {stage.kind === "checking" && (
            <Center padding={6}>
              <Spinner label={t("auth.passwordReset.checking")} />
            </Center>
          )}

          {stage.kind === "invalid" && (
            <>
              <Banner
                status="error"
                title={t("auth.passwordReset.invalidTitle")}
                description={t("auth.passwordReset.invalidBody")}
              />
              <VStack gap={2} hAlign="center">
                {canRequestAnother && (
                  <Link href="/login/forgot-password">
                    {t("auth.passwordReset.requestAnother")}
                  </Link>
                )}
                <Link href="/login">{t("auth.passwordReset.backToSignIn")}</Link>
              </VStack>
            </>
          )}

          {stage.kind === "done" && (
            <>
              <Banner
                status="success"
                title={t("auth.passwordReset.doneTitle")}
                description={t("auth.passwordReset.doneBody")}
              />
              <Button label={t("auth.passwordReset.signIn")} href="/login" width="100%" />
            </>
          )}

          {stage.kind === "form" && (
            <>
              {error && <Banner status="error" title={error} />}
              <Card padding={4}>
                <VStack gap={3}>
                  <SignInIdentity username={stage.link.username} />
                  {/* Unseen, for the password manager to save the new password under. */}
                  <input
                    {...AUTOFILL_USERNAME}
                    type="text"
                    value={stage.link.username}
                    readOnly
                    hidden
                  />
                  <TextInput
                    startIcon={KeyRound}
                    {...AUTOFILL_NEW_PASSWORD}
                    label={t("auth.passwordChange.newPassword")}
                    type="password"
                    value={password}
                    onChange={setPassword}
                    isRequired
                    hasAutoFocus
                    width="100%"
                  />
                  <TextInput
                    startIcon={KeyRound}
                    {...AUTOFILL_NEW_PASSWORD}
                    label={t("auth.passwordChange.confirmPassword")}
                    type="password"
                    value={confirm}
                    onChange={setConfirm}
                    status={
                      isMismatch
                        ? { type: "error", message: t("auth.passwordChange.mismatch") }
                        : undefined
                    }
                    isRequired
                    width="100%"
                  />
                </VStack>
              </Card>
              <Button
                type="submit"
                label={
                  invite ? t("auth.passwordReset.inviteSubmit") : t("auth.passwordReset.submit")
                }
                isLoading={pending}
                isDisabled={pending}
                width="100%"
              />
              <PasswordPolicyChecklist password={password} />
            </>
          )}
        </VStack>
      </form>
    </Center>
  );
}
