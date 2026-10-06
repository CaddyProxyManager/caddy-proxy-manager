"use client";

/**
 * What a migrated deployment is owed once setup finishes: its old database back, and the command
 * that clears the migrated variables out of the `.env` it still has.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Code } from "@astryxdesign/core/Code";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { EnvCleanup } from "@/src/lib/migration/env-file";
import { FormCard } from "@/src/components/ui/FormLayout";
import { useTranslations } from "next-intl";
import { SetupSteps } from "@/src/components/ui/SetupSteps";
import { SqliteSetupWarning } from "@/src/components/setup/SqliteSetupWarning";
import { usePageFrame } from "@/src/components/ui/standalone-page";

export default function SetupDoneClient({
  source,
  cleanup,
  dashboardOrigin,
  sqliteWarning = false,
}: {
  source: string;
  cleanup: EnvCleanup;
  /** Where the dashboard now answers, when setup claimed a domain for it. */
  dashboardOrigin: string | null;
  sqliteWarning?: boolean;
}) {
  const frame = usePageFrame();
  const t = useTranslations("setup");
  const tCommon = useTranslations("common");
  return (
    <Center role={frame.role}>
      <VStack gap={5} padding={5}>
        {/* Reached after setup completes, so every step is behind the operator. The migrate step
            is always present here: this page only exists because a migration happened. */}
        <SetupSteps stage="complete" hasMigrateStep />
        {sqliteWarning && <SqliteSetupWarning />}
        <VStack gap={2}>
          <Heading level={frame.titleLevel}>{t("done.heading")}</Heading>
          <Text color="secondary">{t("migrationCompleteDescription")}</Text>
        </VStack>

        <FormCard title={t("legacyDatabaseBackupTitle")}>
          <VStack gap={3}>
            <Text size="sm" color="secondary">
              {t.rich("legacyDatabaseBackupDescription", {
                source,
                code: (chunks) => <Code>{chunks}</Code>,
              })}
            </Text>
            <Banner
              status="warning"
              title={t("legacyDatabaseUnusedTitle")}
              description={t("legacyDatabaseUnusedDescription")}
            />
            <Link href="/api/setup/backup">{t("legacyDatabaseDownloadLink")}</Link>
          </VStack>
        </FormCard>

        <FormCard title={t("environmentCleanupTitle")}>
          {cleanup.command ? (
            <VStack gap={3}>
              <Text size="sm" color="secondary">
                {t.rich("environmentCleanupDescription", {
                  variables: cleanup.comment.join(" "),
                  code: (chunks) => <Code>{chunks}</Code>,
                })}
              </Text>
              <Code>{cleanup.command}</Code>
              <Text size="sm" color="secondary">
                {t.rich("environmentCleanupElsewhere", {
                  code: (chunks) => <Code>{chunks}</Code>,
                })}
              </Text>
            </VStack>
          ) : (
            <Text size="sm" color="secondary">
              {t("environmentCleanupEmptyDescription")}
            </Text>
          )}

          {cleanup.keep.length > 0 && (
            <Banner
              status="warning"
              title={t("composeSettingsTitle")}
              description={t("composeSettingsDescription", { variables: cleanup.keep.join(", ") })}
            />
          )}
        </FormCard>

        {/* An href rather than a click handler: the destination is a real URL the operator may
            want to open in a second tab, and a button would have swallowed the middle click. */}
        <Button
          variant="primary"
          label={tCommon("continue")}
          href={dashboardOrigin ? `${dashboardOrigin}/` : "/"}
        />
      </VStack>
    </Center>
  );
}
