"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";

/** Named, not explained: an operator recognises `CLICKHOUSE_URL` faster than a sentence. */
export function EnvTokens({ names }: { names?: readonly string[] }) {
  const t = useTranslations("settings");
  if (!names || names.length === 0) return null;
  return (
    // A bare div's aria-label is not exposed; the role names the badges.
    <HStack
      gap={1}
      vAlign="center"
      wrap="wrap"
      role="group"
      aria-label={t("environmentVariablesLabel")}
    >
      {names.map((name) => (
        <Badge key={name} label={name} variant="purple" />
      ))}
    </HStack>
  );
}
