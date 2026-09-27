"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { PasswordPolicyChecklist } from "@/src/components/auth/PasswordPolicyChecklist";
import {
  AUTOFILL_CURRENT_PASSWORD,
  AUTOFILL_NEW_PASSWORD,
} from "@/components/ui/native-input-attrs";
import { passwordPolicyMessage } from "@/src/lib/password-policy-message";

export default function LegacyPasswordChangeForm() {
  const t = useTranslations();
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Only once something has been typed into the confirmation: an empty field is not a mismatch yet.
  const isMismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError(t("auth.passwordChange.mismatch"));
      return;
    }
    const policyError = passwordPolicyMessage(
      t,
      newPassword,
      t("passwordPolicy.subject.newPassword"),
    );
    if (policyError) {
      setError(policyError);
      return;
    }
    if (newPassword === currentPassword) {
      setError(t("auth.passwordChange.mustDiffer"));
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? t("auth.passwordChange.failed"));
        return;
      }
      // The new hash is argon2id, so the dashboard gate no longer matches.
      router.replace("/");
      router.refresh();
    } catch {
      setError(t("auth.passwordChange.failed"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Center minHeight="100vh" padding={4} className="cpm-auth-page">
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 400 }}>
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={1}>{t("auth.passwordChange.heading")}</Heading>
            <Text type="body" size="sm" color="secondary">
              {t("auth.passwordChange.subtitle")}
            </Text>
          </VStack>

          {error && <Banner status="error" title={error} />}

          <Card padding={4}>
            <VStack gap={3}>
              <TextInput
                {...AUTOFILL_CURRENT_PASSWORD}
                label={t("auth.passwordChange.currentPassword")}
                type="password"
                value={currentPassword}
                onChange={setCurrentPassword}
                isRequired
                width="100%"
              />
              <TextInput
                {...AUTOFILL_NEW_PASSWORD}
                label={t("auth.passwordChange.newPassword")}
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                isRequired
                width="100%"
              />
              <TextInput
                {...AUTOFILL_NEW_PASSWORD}
                label={t("auth.passwordChange.confirmPassword")}
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
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

          {/* Straight after the fields, so it stays above the keyboard on a phone. */}
          <Button
            type="submit"
            label={t("auth.passwordChange.submit")}
            isLoading={isSubmitting}
            isDisabled={isSubmitting}
            width="100%"
          />

          <PasswordPolicyChecklist password={newPassword} />
        </VStack>
      </form>
    </Center>
  );
}
