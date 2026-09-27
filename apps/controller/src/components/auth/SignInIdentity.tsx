"use client";

import { UserRound } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";

/**
 * Identifier-first needs the entered name on screen: without it the password step is for an
 * account you cannot see, and a typo in step one looks like a wrong password.
 */
export function SignInIdentity({
  username,
  description,
  onChange,
  isDisabled = false,
}: {
  username: string;
  /** Optional line under the name - e.g. which provider the account signs in through. */
  description?: string;
  onChange: () => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("auth.login");

  return (
    // The default variant, not `muted`: in this theme the muted fill is the same colour as the
    // card this row sits inside, so only the default's border sets the row apart at all.
    <Card padding={2} width="100%">
      <HStack gap={2} vAlign="center" justify="between">
        <HStack gap={2} vAlign="center">
          <Icon icon={UserRound} size="sm" color="secondary" />
          <VStack gap={0}>
            <Text type="body" size="sm">
              {username}
            </Text>
            {description && (
              <Text type="body" size="xsm" color="secondary">
                {description}
              </Text>
            )}
          </VStack>
        </HStack>
        <Button
          variant="ghost"
          size="sm"
          label={t("changeUsername")}
          isDisabled={isDisabled}
          onClick={onChange}
        />
      </HStack>
    </Card>
  );
}
