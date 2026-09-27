"use client";

import { useTranslations } from "next-intl";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { TwoFactorSection } from "@/src/app/(dashboard)/profile/TwoFactorSection";

/**
 * The one thing an admin caught by the policy can do. Turning 2FA on refreshes the page, whose
 * server side then sends them on to the dashboard.
 */
export function TwoFactorSetupClient() {
  const t = useTranslations("auth.twoFactorSetup");
  return (
    <Center minHeight="100vh" padding={4}>
      <Card width={480}>
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={1}>{t("title")}</Heading>
            <Text type="body" size="sm" color="secondary">
              {t("description")}
            </Text>
          </VStack>
          <TwoFactorSection enabled={false} hasPassword locked={false} />
          <form action="/api/auth/logout" method="post">
            <Button type="submit" variant="ghost" label={t("signOut")} width="100%" />
          </form>
        </VStack>
      </Card>
    </Center>
  );
}
