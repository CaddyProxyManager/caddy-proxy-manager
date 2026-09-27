"use client";

import { LogIn } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";

export interface SignInProvider {
  id: string;
  name: string;
  /** At most one, enforced by the settings key behind it. */
  isPrimary?: boolean;
}

/** The primary is `tonal`, not badged: a fill is seen, a badge read. Solid stays with submit. */
export function SignInProviders({
  providers,
  pendingId,
  isDisabled,
  onSelect,
}: {
  providers: SignInProvider[];
  pendingId: string | null;
  isDisabled: boolean;
  onSelect: (providerId: string) => void;
}) {
  const t = useTranslations("auth.login");

  return (
    <VStack gap={2}>
      {providers.map((provider) => {
        const isPending = pendingId === provider.id;
        return (
          <Button
            key={provider.id}
            variant={provider.isPrimary ? "tonal" : "secondary"}
            width="100%"
            icon={<LogIn />}
            // Not concatenated: not every language puts the provider last.
            label={
              isPending
                ? t("signingInWith", { provider: provider.name })
                : t("continueWith", { provider: provider.name })
            }
            isLoading={isPending}
            isDisabled={isDisabled}
            onClick={() => onSelect(provider.id)}
          />
        );
      })}
    </VStack>
  );
}
