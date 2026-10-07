"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Download, KeyRound, Upload } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Heading } from "@astryxdesign/core/Heading";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { CheckboxInput } from "@/components/ui/FormBooleanControls";
import { AUTOFILL_NEW_PASSWORD, AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { Timestamp } from "@/components/ui/Timestamp";
import type { StagedView } from "@/src/lib/settings/staged-view";
import type { RemoteBackup } from "@/src/lib/backup/manage";
import SettingsFrame from "../SettingsFrame";
import { type BackupOverview, listRemoteBackupsAction } from "./actions";
import { ConfigTransfer } from "./ConfigTransfer";
import { ScheduledBackups } from "./ScheduledBackups";

type Preview = {
  createdAt: string;
  appVersion: string;
  counts: Record<string, number>;
  newerThanThis: boolean;
};

/** `MIN_PASSPHRASE_LENGTH` in lib/backup/format.ts, which pulls node:crypto into the bundle. */
const MIN_PASSPHRASE = 12;

/** The tables worth naming in the preview; the rest are counted together. */
const HEADLINE_TABLES = {
  proxy_hosts: "proxyHosts",
  l4_proxy_hosts: "l4ProxyHosts",
  users: "users",
  certificates: "certificates",
  access_lists: "accessLists",
} as const;

function DownloadCard() {
  const t = useTranslations("settings.backup");
  const tCommon = useTranslations("common");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [auditLog, setAuditLog] = useState(false);
  const [settingsHistory, setSettingsHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirmation.length > 0 && confirmation !== passphrase;
  const ready = passphrase.length >= MIN_PASSPHRASE && confirmation === passphrase;

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase, auditLog, settingsHistory }),
      });
      if (!response.ok) {
        setError(((await response.json()) as { error?: string }).error ?? t("downloadFailed"));
        return;
      }
      const name =
        /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ??
        "cpm-backup.cpmbak";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setPassphrase("");
      setConfirmation("");
    } catch {
      setError(t("downloadFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <Heading level={3} accessibilityLevel={2}>
          {t("downloadTitle")}
        </Heading>
        <Text type="body" size="sm" color="secondary">
          {t("downloadHelp")}
        </Text>
        {error && <Banner status="error" title={t("downloadFailed")} description={error} />}
        <TextInput
          startIcon={KeyRound}
          {...AUTOFILL_NEW_PASSWORD}
          label={t("passphrase")}
          description={t("passphraseHelp", { min: MIN_PASSPHRASE })}
          type="password"
          value={passphrase}
          onChange={setPassphrase}
          width="100%"
        />
        <TextInput
          startIcon={KeyRound}
          {...AUTOFILL_NEW_PASSWORD}
          label={t("passphraseConfirm")}
          type="password"
          value={confirmation}
          onChange={setConfirmation}
          status={mismatch ? { type: "error", message: t("passphraseMismatch") } : undefined}
          width="100%"
        />
        <CheckboxInput label={t("includeAuditLog")} value={auditLog} onChange={setAuditLog} />
        <CheckboxInput
          label={t("includeSettingsHistory")}
          value={settingsHistory}
          onChange={setSettingsHistory}
        />
        <Text type="supporting">{t("notIncluded")}</Text>
        <Button
          icon={<Download />}
          label={tCommon("download")}
          onClick={download}
          isLoading={busy}
          isDisabled={!ready || busy}
        />
      </VStack>
    </Card>
  );
}

/** Where the backup to restore comes from: an uploaded file, or one a destination holds. */
type Source = { kind: "file"; file: File } | { kind: "remote"; destinationId: number; key: string };

function sourceForm(source: Source): FormData {
  const form = new FormData();
  if (source.kind === "file") form.set("file", source.file);
  else {
    form.set("destinationId", String(source.destinationId));
    form.set("key", source.key);
  }
  return form;
}

function RestoreCard({ destinations }: { destinations: BackupOverview["destinations"] }) {
  const t = useTranslations("settings.backup");
  const tSchedules = useTranslations("settings.backupSchedules");
  const [from, setFrom] = useState<"file" | "destination">("file");
  const [destinationId, setDestinationId] = useState<string>("");
  const [remote, setRemote] = useState<RemoteBackup[] | null>(null);
  const [remoteKey, setRemoteKey] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [keepAgents, setKeepAgents] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const describe = async (chosen: Source | null) => {
    setSource(chosen);
    setPreview(null);
    setError(null);
    if (!chosen) return;
    const form = sourceForm(chosen);
    form.set("preview", "1");
    try {
      const response = await fetch("/api/backup/restore", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setError(body.error ?? t("restoreFailed"));
      else setPreview(body as Preview);
    } catch {
      setError(t("restoreFailed"));
    }
  };

  const choose = (chosen: File | null) => {
    setFile(chosen);
    void describe(chosen ? { kind: "file", file: chosen } : null);
  };

  const pickDestination = async (id: string) => {
    setDestinationId(id);
    setRemote(null);
    setRemoteKey("");
    void describe(null);
    try {
      setRemote(await listRemoteBackupsAction(Number(id)));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("listFailed"));
    }
  };

  const pickRemote = (key: string) => {
    setRemoteKey(key);
    void describe({ kind: "remote", destinationId: Number(destinationId), key });
  };

  const restore = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const form = sourceForm(source);
      form.set("passphrase", passphrase);
      form.set("keepAgents", keepAgents ? "1" : "0");
      const response = await fetch("/api/backup/restore", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? t("restoreFailed"));
        return;
      }
      // Every session, this one included, went with the accounts the backup replaced.
      window.location.assign("/login");
    } catch {
      setError(t("restoreFailed"));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const others = preview
    ? Object.entries(preview.counts)
        .filter(([table]) => !(table in HEADLINE_TABLES))
        .reduce((sum, [, count]) => sum + count, 0)
    : 0;

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <Heading level={3} accessibilityLevel={2}>
          {t("restoreTitle")}
        </Heading>
        <Text type="body" size="sm" color="secondary">
          {t("restoreHelp")}
        </Text>
        {error && <Banner status="error" title={t("restoreFailed")} description={error} />}
        {destinations.length > 0 && (
          <SegmentedControl
            label={t("restoreFrom")}
            size="sm"
            value={from}
            onChange={(value) => {
              setFrom(value === "destination" ? "destination" : "file");
              void describe(null);
            }}
          >
            <SegmentedControlItem value="file" label={t("fromFile")} />
            <SegmentedControlItem value="destination" label={t("fromDestination")} />
          </SegmentedControl>
        )}
        {from === "file" ? (
          <FileInput
            label={t("chooseFile")}
            accept=".cpmbak"
            value={file}
            onChange={(chosen) => choose(Array.isArray(chosen) ? (chosen[0] ?? null) : chosen)}
          />
        ) : (
          <VStack gap={3}>
            <Selector
              label={tSchedules("destination")}
              size="sm"
              width={320}
              placeholder={t("chooseDestination")}
              options={destinations.map((destination) => ({
                value: String(destination.id),
                label: destination.name,
              }))}
              value={destinationId || undefined}
              onChange={(value) => void pickDestination(value)}
            />
            {remote && remote.length === 0 && (
              <Text type="body" size="sm" color="secondary">
                {t("remoteEmpty")}
              </Text>
            )}
            {remote && remote.length > 0 && (
              <Selector
                label={t("remoteBackup")}
                size="sm"
                width="100%"
                placeholder={t("chooseRemoteBackup")}
                options={remote.map((object) => ({ value: object.key, label: object.key }))}
                value={remoteKey || undefined}
                onChange={pickRemote}
              />
            )}
          </VStack>
        )}

        {preview && (
          <VStack gap={3}>
            {preview.newerThanThis && (
              <Banner status="error" title={t("newerTitle")} description={t("newerHelp")} />
            )}
            <MetadataList>
              <MetadataListItem label={t("madeAt")}>
                <Timestamp value={preview.createdAt} style="dateTimeShort" />
              </MetadataListItem>
              <MetadataListItem label={t("madeBy")}>{preview.appVersion}</MetadataListItem>
              {Object.entries(HEADLINE_TABLES).map(([table, key]) => (
                <MetadataListItem key={table} label={t(`tables.${key}`)}>
                  {preview.counts[table] ?? 0}
                </MetadataListItem>
              ))}
              <MetadataListItem label={t("tables.other")}>{others}</MetadataListItem>
            </MetadataList>
            <TextInput
              startIcon={KeyRound}
              {...AUTOFILL_OFF}
              label={t("passphrase")}
              type="password"
              value={passphrase}
              onChange={setPassphrase}
              width="100%"
            />
            <CheckboxInput
              label={t("keepAgents")}
              description={t("keepAgentsHelp")}
              value={keepAgents}
              onChange={setKeepAgents}
            />
            <Button
              variant="destructive"
              icon={<Upload />}
              label={t("restore")}
              isDisabled={passphrase.length < MIN_PASSPHRASE || preview.newerThanThis || busy}
              onClick={() => setConfirmOpen(true)}
            />
          </VStack>
        )}

        <AlertDialog
          isOpen={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={t("confirmTitle")}
          description={t("confirmHelp")}
          actionLabel={t("restore")}
          onAction={restore}
        />
      </VStack>
    </Card>
  );
}

export default function BackupClient({
  staged,
  overview,
}: {
  staged: StagedView;
  overview: BackupOverview;
}) {
  const t = useTranslations("settings");
  return (
    <SettingsFrame sectionId={null} title={t("backup.title")} staged={staged} aside={false}>
      <VStack gap={6}>
        <DownloadCard />
        <ScheduledBackups initial={overview} />
        <RestoreCard destinations={overview.destinations} />
        <ConfigTransfer />
      </VStack>
    </SettingsFrame>
  );
}
