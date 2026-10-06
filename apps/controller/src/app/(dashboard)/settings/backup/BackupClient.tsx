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
import { CheckboxInput } from "@/components/ui/FormBooleanControls";
import { AUTOFILL_NEW_PASSWORD, AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { Timestamp } from "@/components/ui/Timestamp";
import type { StagedView } from "@/src/lib/settings/staged-view";
import SettingsFrame from "../SettingsFrame";
import { ConfigTransfer } from "./ConfigTransfer";

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

function RestoreCard() {
  const t = useTranslations("settings.backup");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [keepAgents, setKeepAgents] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (chosen: File | null) => {
    setFile(chosen);
    setPreview(null);
    setError(null);
    if (!chosen) return;
    const form = new FormData();
    form.set("file", chosen);
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

  const restore = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
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
        <FileInput
          label={t("chooseFile")}
          accept=".cpmbak"
          value={file}
          onChange={(chosen) => choose(Array.isArray(chosen) ? (chosen[0] ?? null) : chosen)}
        />

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

export default function BackupClient({ staged }: { staged: StagedView }) {
  const t = useTranslations("settings");
  return (
    <SettingsFrame sectionId={null} title={t("backup.title")} staged={staged} aside={false}>
      <VStack gap={6}>
        <DownloadCard />
        <RestoreCard />
        <ConfigTransfer />
      </VStack>
    </SettingsFrame>
  );
}
