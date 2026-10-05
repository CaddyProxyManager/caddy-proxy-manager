"use client";

import { useTranslations } from "next-intl";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { TwoFactorSection } from "@/src/app/(dashboard)/profile/TwoFactorSection";
import { PasskeySection } from "@/src/app/(dashboard)/profile/PasskeySection";
import type { PasskeySummary } from "@/src/lib/auth/passkeys";
import { usePageFrame } from "@/src/components/ui/standalone-page";

/**
 * The one thing an account caught by the policy can do: an authenticator app or a passkey. Either
 * refreshes the page, whose server side then sends them on to the dashboard.
 */
export function TwoFactorSetupClient({
  passkeys,
  rpId,
  locked,
}: {
  passkeys: PasskeySummary[];
  rpId: string | null;
  locked: boolean;
}) {
  const frame = usePageFrame();
  const t = useTranslations("auth.twoFactorSetup");
  const tCommon = useTranslations("common");
  return (
    <Center role={frame.role} minHeight="100vh" padding={4}>
      <Card width={480}>
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={frame.titleLevel}>{t("title")}</Heading>
            <Text type="body" size="sm" color="secondary">
              {t("description")}
            </Text>
          </VStack>
          <TwoFactorSection enabled={false} hasPassword locked={false} />
          <Divider />
          <VStack gap={1}>
            <Heading level={2}>{t("passkeyTitle")}</Heading>
            <Text type="body" size="sm" color="secondary">
              {t("passkeyDescription")}
            </Text>
          </VStack>
          <PasskeySection passkeys={passkeys} rpId={rpId} locked={locked} />
          <form action="/api/auth/logout" method="post">
            <Button type="submit" variant="ghost" label={tCommon("signOut")} width="100%" />
          </form>
        </VStack>
      </Card>
    </Center>
  );
}
