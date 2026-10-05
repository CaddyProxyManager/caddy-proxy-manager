"use client";

/**
 * Which old database to migrate, and which parts. Candidates show their counts and last write,
 * the only way to tell a live file from a backup beside it; groups let a handover skip the users.
 */
import { KeyRound } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { FormCard, StatusAlert } from "@/src/components/ui/FormLayout";
import { SetupSteps } from "@/src/components/ui/SetupSteps";
import { AUTOFILL_OFF } from "@/src/components/ui/native-input-attrs";
import {
  ALL_MIGRATION_GROUP_IDS,
  MIGRATION_GROUPS,
  type MigrationGroupId,
  withRequiredGroups,
} from "@/src/lib/migration/selection";
import { migrationGroupDescription, migrationGroupLabel } from "@/src/lib/migration/messages";
import { skipMigration } from "./actions";
import RestartDialog from "@/src/components/setup/RestartDialog";
import { useFormatter, useTranslations } from "next-intl";
import type { LegacyRejection } from "@/src/lib/migration/legacy-database";
import { SqliteSetupWarning } from "@/src/components/setup/SqliteSetupWarning";

export type Candidate = {
  path: string;
  sizeBytes: number;
  users: number;
  proxyHosts: number;
  certificates: number;
  groupCounts: Record<MigrationGroupId, number>;
  lastUpdatedAt: string | null;
  /** Encrypted with a `SESSION_SECRET` we lack; decided server-side, the only side with the key. */
  needsLegacyKey: boolean;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <HStack gap={3} justify="between" align="center">
      <Text size="sm" color="secondary">
        {label}
      </Text>
      <Text size="sm" weight="medium">
        {value}
      </Text>
    </HStack>
  );
}

export default function SetupMigrateClient({
  candidates,
  rejected,
  sqliteWarning = false,
}: {
  candidates: Candidate[];
  rejected: LegacyRejection[];
  sqliteWarning?: boolean;
}) {
  const t = useTranslations("setup");
  const format = useFormatter();
  // Literal keys, so the catalog is type-checked; the detail is SQLite's own words.
  const rejectionReason = (entry: LegacyRejection): string => {
    switch (entry.reason) {
      case "missingFile":
        return t("skippedReasons.missingFile");
      case "unreadable":
        return t("skippedReasons.unreadable", { detail: entry.detail ?? "" });
      case "notCpm":
        return t("skippedReasons.notCpm", {
          tables: format.list(entry.missingTables ?? [], { type: "conjunction" }),
        });
      case "readFailed":
        return t("skippedReasons.readFailed", { detail: entry.detail ?? "" });
    }
  };
  const [selected, setSelected] = useState(candidates[0]?.path ?? "");
  // Everything by default, so pressing straight through migrates it all.
  const [picked, setPicked] = useState<MigrationGroupId[]>(ALL_MIGRATION_GROUP_IDS);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Never stored: the import re-encrypts everything under the current key.
  const [legacyKey, setLegacyKey] = useState("");
  // The server asked though the probe did not: a secret rotated more than once.
  const [keyDemanded, setKeyDemanded] = useState(false);
  const [imported, setImported] = useState<{
    next: string;
    migratedSignIn: boolean;
    restartToken: string;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const candidate = candidates.find((entry) => entry.path === selected);

  /** A dependency of a ticked group shows ticked and locked, not silently added, so it says why. */
  const { effective, lockedBy } = useMemo(() => {
    const resolved = new Set(withRequiredGroups(picked));
    // Ids, not labels, so names are translated where rendered.
    const locks = new Map<MigrationGroupId, MigrationGroupId[]>();
    const chosen = new Set(picked);

    for (const group of MIGRATION_GROUPS) {
      if (!chosen.has(group.id)) continue;
      for (const required of withRequiredGroups([group.id])) {
        if (required === group.id) continue;
        locks.set(required, [...(locks.get(required) ?? []), group.id]);
      }
    }

    return { effective: resolved, lockedBy: locks };
  }, [picked]);

  async function runMigration(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setRunning(true);
    // Close first: an open sheet would hide the error banner behind it.
    setConfirming(false);

    try {
      const response = await fetch("/api/setup/migrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: selected, groups: [...effective], legacyKey }),
      });
      const body = (await response.json()) as
        | { ok: true; next: string; migratedSignIn: boolean; restartToken: string }
        | { ok: false; error: string; code?: "legacy-key-required" | "legacy-key-invalid" };

      if (!body.ok) {
        setError(body.error);
        // Either code shows the field: secrets the probe missed, or a mistyped key to fix.
        if (body.code) setKeyDemanded(true);
        return;
      }
      setImported({
        next: body.next,
        migratedSignIn: body.migratedSignIn,
        restartToken: body.restartToken,
      });
    } catch {
      // Can outlast a proxy's idle timeout; a bare "failed" invites a retry onto a half-full db.
      setError(t("migrationConnectionDropped"));
    } finally {
      setRunning(false);
    }
  }

  function toggle(id: MigrationGroupId, checked: boolean): void {
    setPicked((current) =>
      checked ? [...new Set([...current, id])] : current.filter((entry) => entry !== id),
    );
  }

  const migratingUsers = effective.has("users");
  const migratingOAuth = effective.has("oauthProviders");
  // Once shown the field stays, so a wrong key does not hide the box being fixed.
  const needsLegacyKey = (candidate?.needsLegacyKey ?? false) || keyDemanded;
  const blocked = effective.size === 0 || running || (needsLegacyKey && !legacyKey.trim());

  /** On `effective`, not `picked`, so dependency-locked groups count as coming across. */
  const { copying, leaving } = useMemo(() => {
    const tally = (included: boolean) =>
      MIGRATION_GROUPS.filter((group) => effective.has(group.id) === included).reduce(
        (sum, group) => ({
          groups: sum.groups + 1,
          rows: sum.rows + (candidate?.groupCounts?.[group.id] ?? 0),
        }),
        { groups: 0, rows: 0 },
      );
    return { copying: tally(true), leaving: tally(false) };
  }, [effective, candidate]);

  if (imported) {
    return (
      <RestartDialog
        next={imported.next}
        restartToken={imported.restartToken}
        copy={{
          heading: t("done.heading"),
          lead: t("migrationCopiedDescription"),
          title: t("migrationRestartTitle"),
          description: t("migrationRestartDescription"),
          note: imported.migratedSignIn ? t("restartSignInMigrated") : t("restartSignInFresh"),
          manually: t("restartManually"),
          manuallyWithDetail: (detail) => t("restartManuallyWithDetail", { detail }),
        }}
      />
    );
  }

  return (
    <Center role="main">
      <VStack gap={5} padding={5}>
        <SetupSteps stage="migrate" hasMigrateStep />
        {sqliteWarning && <SqliteSetupWarning />}
        <VStack gap={2}>
          <Heading level={1}>{t("migrate.heading")}</Heading>
          <Text color="secondary">{t("migrationDescription")}</Text>
        </VStack>

        {error && <StatusAlert message={error} success={false} />}

        <form ref={formRef} onSubmit={runMigration}>
          <VStack gap={4}>
            <FormCard title={t("databasesFound")}>
              <VStack gap={3}>
                {candidates.map((entry) => {
                  const isSelected = selected === entry.path;
                  return (
                    <SelectableCard
                      key={entry.path}
                      variant="muted"
                      padding={3}
                      width="100%"
                      label={entry.path}
                      isSelected={isSelected}
                      onChange={() => setSelected(entry.path)}
                    >
                      <VStack gap={1} align="start">
                        <Text size="sm" weight="medium">
                          {entry.path}
                        </Text>
                        <HStack gap={3}>
                          <Text size="xsm" color="secondary">
                            {t("migrationCandidateUsers", { count: entry.users })}
                          </Text>
                          <Text size="xsm" color="secondary">
                            {t("migrationCandidateProxyHosts", { count: entry.proxyHosts })}
                          </Text>
                          <Text size="xsm" color="secondary">
                            {t("migrationCandidateCertificates", { count: entry.certificates })}
                          </Text>
                          <Text size="xsm" color="secondary">
                            {formatSize(entry.sizeBytes)}
                          </Text>
                        </HStack>
                        {entry.lastUpdatedAt && (
                          <Text size="xsm" color="secondary">
                            {t("migrationCandidateLastWritten", { date: entry.lastUpdatedAt })}
                          </Text>
                        )}
                      </VStack>
                    </SelectableCard>
                  );
                })}
              </VStack>
            </FormCard>

            {rejected.length > 0 && (
              <FormCard title={t("skippedFilesTitle")}>
                <VStack gap={2}>
                  {rejected.map((entry) => (
                    <Text key={entry.path} size="xsm" color="secondary">
                      {t("skippedFile", { path: entry.path, reason: rejectionReason(entry) })}
                    </Text>
                  ))}
                </VStack>
              </FormCard>
            )}

            <FormCard title={t("whatToMigrate")}>
              <VStack gap={3}>
                <Text size="sm" color="secondary">
                  {t("migrationSelectionHelp")}
                </Text>
                {MIGRATION_GROUPS.map((group) => {
                  const requiredBy = lockedBy
                    .get(group.id)
                    ?.map((id) => migrationGroupLabel(t, id))
                    .join(", ");
                  const rows = candidate?.groupCounts?.[group.id];
                  const label = migrationGroupLabel(t, group.id);
                  const description = migrationGroupDescription(t, group.id);
                  return (
                    <CheckboxInput
                      key={group.id}
                      label={
                        rows === undefined
                          ? label
                          : t("migrationGroupWithRows", { group: label, rows })
                      }
                      description={
                        requiredBy
                          ? t("migrationGroupRequiredBy", { description, groups: requiredBy })
                          : description
                      }
                      value={effective.has(group.id)}
                      isDisabled={requiredBy !== undefined}
                      disabledMessage={
                        requiredBy && t("migrationGroupUntickFirst", { groups: requiredBy })
                      }
                      onChange={(checked) => toggle(group.id, checked)}
                    />
                  );
                })}
              </VStack>
            </FormCard>

            {!migratingUsers && (
              <Banner
                status="info"
                title={t("accountsExcludedTitle")}
                description={
                  migratingOAuth
                    ? t("accountsExcludedOAuthDescription")
                    : t("accountsExcludedDescription")
                }
              />
            )}

            {needsLegacyKey && (
              <FormCard title={t("legacySecretRequiredTitle")}>
                <VStack gap={3}>
                  <Text size="sm" color="secondary">
                    {t.rich("legacySecretRequiredDescription", {
                      code: (chunks) => <code>{chunks}</code>,
                    })}
                  </Text>
                  <TextInput
                    startIcon={KeyRound}
                    {...AUTOFILL_OFF}
                    label={t("legacySecretLabel")}
                    htmlName="legacyKey"
                    type="password"
                    description={t("legacySecretHelp")}
                    value={legacyKey}
                    onChange={setLegacyKey}
                    isRequired
                    width="100%"
                  />
                  <Banner
                    status="info"
                    title={t("secretReencryptionTitle")}
                    description={t("secretReencryptionDescription")}
                  />
                </VStack>
              </FormCard>
            )}

            <Banner
              status="warning"
              title={t("emptyDatabaseRequiredTitle")}
              description={t("emptyDatabaseRequiredDescription")}
            />

            {/* Confirms first: the import is one-way and the selection easy to get wrong. */}
            <Button
              variant="primary"
              label={running ? t("migrate.submitPending") : t("migrate.submit")}
              isDisabled={blocked}
              onClick={() => setConfirming(true)}
            />
          </VStack>
        </form>

        <BottomSheet
          label={t("migrate.confirmTitle")}
          isOpen={confirming}
          onOpenChange={setConfirming}
          // A swipe or scrim tap means Cancel here, so nothing is blocked.
          purpose="info"
        >
          {/* Only while open: a closed, still-mounted sheet would duplicate the page's text for
              find-in-page, screen readers and locators. */}
          {confirming && (
            <VStack gap={4} padding={4}>
              <VStack gap={2}>
                <Heading level={2}>{t("migrate.confirmTitle")}</Heading>
                <Text color="secondary">{t("migrate.confirmDescription")}</Text>
              </VStack>

              <Card>
                <VStack gap={3} padding={3}>
                  <SummaryRow label={t("migrate.confirmSource")} value={selected} />
                  <SummaryRow
                    label={t("migrate.confirmCopying")}
                    value={t("migrate.confirmGroups", {
                      groups: copying.groups,
                      rows: copying.rows,
                    })}
                  />
                  <SummaryRow
                    label={t("migrate.confirmLeaving")}
                    value={
                      leaving.groups === 0
                        ? t("migrate.confirmNothing")
                        : t("migrate.confirmGroups", { groups: leaving.groups, rows: leaving.rows })
                    }
                  />
                  <SummaryRow
                    label={t("migrate.confirmSecrets")}
                    value={
                      needsLegacyKey
                        ? t("migrate.confirmSecretsReencrypted")
                        : t("migrate.confirmSecretsUnchanged")
                    }
                  />
                </VStack>
              </Card>

              {!migratingUsers && (
                <Banner
                  status="warning"
                  title={t("migrate.confirmNoAccountsTitle")}
                  description={t("migrate.confirmNoAccountsDescription")}
                />
              )}

              <Text size="sm" color="secondary">
                {t("migrate.confirmFootnote")}
              </Text>

              <VStack gap={2}>
                <Button
                  variant="primary"
                  // Not the trigger's name: two buttons with one accessible name are ambiguous.
                  label={t("migrate.confirmStart")}
                  isDisabled={blocked}
                  // The sheet is its own dialog, so a submit button here has no form.
                  onClick={() => formRef.current?.requestSubmit()}
                />
                <Button
                  variant="secondary"
                  label={t("migrate.confirmCancel")}
                  onClick={() => setConfirming(false)}
                />
              </VStack>
            </VStack>
          )}
        </BottomSheet>

        <FormCard title={t("orStartFresh")}>
          <VStack gap={3}>
            <Text size="sm" color="secondary">
              {t("skipMigrationDescription")}
            </Text>
            <form action={skipMigration}>
              <Button type="submit" variant="secondary" size="sm" label={t("skipMigrationLabel")} />
            </form>
          </VStack>
        </FormCard>
      </VStack>
    </Center>
  );
}
