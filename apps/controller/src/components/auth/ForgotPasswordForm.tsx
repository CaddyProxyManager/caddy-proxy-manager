"use client";

import { User } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { AUTOFILL_USERNAME, NO_SPELLCHECK } from "@/src/components/ui/native-input-attrs";
import { usePageFrame } from "@/src/components/ui/standalone-page";

export default function ForgotPasswordForm({ appName }: { appName: string }) {
  const frame = usePageFrame();
  const t = useTranslations("auth.passwordReset");
  const [identifier, setIdentifier] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      if (response.status === 429) {
        setError(t("tooMany"));
        return;
      }
      if (!response.ok) {
        setError(t("requestFailed"));
        return;
      }
      setSent(true);
    } catch {
      setError(t("requestFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Center role={frame.role} minHeight="100vh" padding={4}>
      <Card width={400}>
        <VStack gap={4}>
          <VStack gap={1} hAlign="center">
            <Heading level={frame.titleLevel}>{appName}</Heading>
            <Text type="body" size="sm" color="secondary" justify="center">
              {t("requestSubtitle")}
            </Text>
          </VStack>

          {error && <Banner status="error" title={error} />}

          {sent ? (
            <Banner status="success" title={t("requestSentTitle")} description={t("requestSent")} />
          ) : (
            <form onSubmit={handleSubmit}>
              <VStack gap={3}>
                <TextInput
                  startIcon={User}
                  {...AUTOFILL_USERNAME}
                  {...NO_SPELLCHECK}
                  label={t("identifier")}
                  description={t("identifierHelp")}
                  htmlName="identifier"
                  value={identifier}
                  onChange={setIdentifier}
                  isRequired
                  hasAutoFocus={frame.autoFocus}
                  isDisabled={pending}
                  width="100%"
                />
                <Button
                  type="submit"
                  variant="primary"
                  label={t("send")}
                  isLoading={pending}
                  isDisabled={pending}
                  width="100%"
                />
              </VStack>
            </form>
          )}

          <VStack hAlign="center">
            <Link href="/login">{t("backToSignIn")}</Link>
          </VStack>
        </VStack>
      </Card>
    </Center>
  );
}
