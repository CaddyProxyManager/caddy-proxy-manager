"use client";

import { KeyRound, Mail, User } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { PasswordPolicyChecklist } from "@/src/components/auth/PasswordPolicyChecklist";
import {
  AUTOFILL_EMAIL,
  AUTOFILL_NAME,
  AUTOFILL_NEW_PASSWORD,
  NO_SPELLCHECK,
} from "@/src/components/ui/native-input-attrs";
import { usePageFrame } from "@/src/components/ui/standalone-page";
import { authClient } from "@/src/lib/auth/client";
import { passwordPolicyMessage } from "@/src/lib/auth/password/policy-message";
import { signUpErrorMessage } from "@/src/lib/auth/sign-up-error";
import { APP_VERSION, appVersionLabel, PRODUCT_NAME } from "@/src/lib/runtime/app-version";

/** The page has already checked that self-registration is on; the server checks again on submit. */
export default function SignUpClient({ appName = PRODUCT_NAME }: { appName?: string }) {
  const frame = usePageFrame();
  const t = useTranslations("auth.signUp");
  const tRoot = useTranslations();
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("auth.errors");
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isMismatch = confirm.length > 0 && confirm !== password;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    // Not FormData: Astryx drops `name` from disabled inputs, and these disable while pending.
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      setError(t("nameRequired"));
      return;
    }
    if (!trimmedEmail) {
      setError(t("emailRequired"));
      return;
    }
    if (password !== confirm) {
      setError(tCommon("passwordsDoNotMatch"));
      return;
    }
    // The server applies the same rule (auth/signup-policy.ts); this spares the round trip.
    const policyError = passwordPolicyMessage(
      tRoot,
      password,
      tRoot("passwordPolicy.subject.password"),
    );
    if (policyError) {
      setError(policyError);
      return;
    }

    setPending(true);
    const { error: refused } = await authClient.signUp.email({
      name: trimmedName,
      email: trimmedEmail,
      password,
    });
    if (refused) {
      setError(signUpErrorMessage(refused, (key) => tErrors(key)));
      setPending(false);
      return;
    }

    // Better Auth signs the new account in; land where a fresh sign-in does.
    router.replace("/");
    router.refresh();
  };

  return (
    <Center role={frame.role} minHeight="100vh" padding={4}>
      <Card width={400}>
        <VStack gap={4}>
          <VStack gap={1} hAlign="center">
            <Heading level={frame.titleLevel}>{appName}</Heading>
            <Text type="body" size="sm" color="secondary">
              {t("subtitle")}
            </Text>
          </VStack>

          {error && <Banner status="error" title={t("failedTitle")} description={error} />}

          <form onSubmit={handleSubmit}>
            <VStack gap={3}>
              <TextInput
                startIcon={User}
                {...AUTOFILL_NAME}
                label={tCommon("name")}
                htmlName="name"
                value={name}
                onChange={setName}
                isRequired
                hasAutoFocus={frame.autoFocus}
                isDisabled={pending}
                width="100%"
              />
              <TextInput
                startIcon={Mail}
                {...AUTOFILL_EMAIL}
                {...NO_SPELLCHECK}
                label={tCommon("email")}
                type="email"
                htmlName="email"
                value={email}
                onChange={setEmail}
                isRequired
                isDisabled={pending}
                width="100%"
              />
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_NEW_PASSWORD}
                label={tCommon("password")}
                type="password"
                htmlName="password"
                value={password}
                onChange={setPassword}
                isRequired
                isDisabled={pending}
                width="100%"
              />
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_NEW_PASSWORD}
                label={tCommon("confirmPassword")}
                type="password"
                htmlName="passwordConfirmation"
                value={confirm}
                onChange={setConfirm}
                status={
                  isMismatch
                    ? { type: "error", message: tCommon("passwordsDoNotMatch") }
                    : undefined
                }
                isRequired
                isDisabled={pending}
                width="100%"
              />
              <Button
                type="submit"
                variant="primary"
                label={pending ? t("submitPending") : t("submit")}
                isLoading={pending}
                isDisabled={pending}
                width="100%"
              />
            </VStack>
          </form>

          <PasswordPolicyChecklist password={password} />

          <VStack hAlign="center">
            <Link href="/login">{tRoot("auth.passwordReset.backToSignIn")}</Link>
          </VStack>

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
