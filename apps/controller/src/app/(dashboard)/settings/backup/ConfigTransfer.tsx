"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Download, KeyRound, ScanSearch, Upload } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { AuditChanges } from "@/components/audit/AuditChanges";
import { AUTOFILL_NEW_PASSWORD, AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { Timestamp } from "@/components/ui/Timestamp";
import type {
  ConfigImportItem,
  ConfigImportPreview,
  ConfigSection,
} from "@/src/lib/config-transfer";

/** `CONFIG_SECTIONS` in lib/config-transfer/format.ts, which pulls node:crypto into the bundle. */
const SECTIONS: ConfigSection[] = [
  "hosts",
  "accessLists",
  "certificates",
  "groups",
  "security",
  "settings",
];
const MIN_PASSPHRASE = 12;

type Described = { exportedAt: string; appVersion: string; counts: Record<string, number> };

const ACTION_COLOR = { create: "green", update: "blue", skip: "gray" } as const;

/** What a refused request says, and whether a fresh sign-in is what it wants. */
type Failure = { message: string; reauth: boolean };

async function failureOf(response: Response, fallback: string): Promise<Failure> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  return { message: body.error ?? fallback, reauth: body.code === "reauth-required" };
}

/** Export and import hand over every key, so they want a recent sign-in, as a restore does. */
function FailureBanner({ failure, title }: { failure: Failure; title: string }) {
  const t = useTranslations("settings.configTransfer");
  const tCommon = useTranslations("common");
  if (!failure.reauth) return <Banner status="error" title={title} description={failure.message} />;
  return (
    <Banner
      status="warning"
      title={t("reauthTitle")}
      description={failure.message}
      endContent={
        <form action="/api/auth/logout" method="post">
          <Button type="submit" size="sm" variant="secondary" label={tCommon("signOut")} />
        </form>
      }
    />
  );
}

function ExportCard() {
  const t = useTranslations("settings.configTransfer");
  const tErrors = useTranslations("errors");
  const tBackup = useTranslations("settings.backup");
  const [sections, setSections] = useState<string[]>(SECTIONS);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  const mismatch = confirmation.length > 0 && confirmation !== passphrase;
  const ready =
    sections.length > 0 && passphrase.length >= MIN_PASSPHRASE && confirmation === passphrase;

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/config/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase, sections }),
      });
      if (!response.ok) {
        setError(await failureOf(response, tErrors("configExportFailed")));
        return;
      }
      const name =
        /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ??
        "cpm-config.json";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setPassphrase("");
      setConfirmation("");
    } catch {
      setError({ message: tErrors("configExportFailed"), reauth: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <Heading level={3} accessibilityLevel={2}>
          {t("exportTitle")}
        </Heading>
        <Text type="body" size="sm" color="secondary">
          {t("exportHelp")}
        </Text>
        {error && <FailureBanner failure={error} title={tErrors("configExportFailed")} />}
        <CheckboxList label={t("sectionsLabel")} value={sections} onChange={setSections}>
          {SECTIONS.map((section) => (
            <CheckboxListItem key={section} value={section} label={t(`sections.${section}`)} />
          ))}
        </CheckboxList>
        <TextInput
          startIcon={KeyRound}
          {...AUTOFILL_NEW_PASSWORD}
          label={t("passphrase")}
          description={tBackup("passphraseHelp", { min: MIN_PASSPHRASE })}
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
          status={mismatch ? { type: "error", message: tBackup("passphraseMismatch") } : undefined}
          width="100%"
        />
        <Button
          icon={<Download />}
          label={t("export")}
          onClick={download}
          isLoading={busy}
          isDisabled={!ready || busy}
        />
      </VStack>
    </Card>
  );
}

function ItemLine({ item }: { item: ConfigImportItem }) {
  const t = useTranslations("settings.configTransfer");
  const tErrors = useTranslations("errors");
  const errorCode = item.values.code as Parameters<typeof tErrors>[0] | undefined;
  const reason = item.reason
    ? t(`reasons.${item.reason}`, {
        domain: item.values.domain ?? "",
        host: item.values.host ?? "",
        listen: item.values.listen ?? "",
        name: item.values.name ?? "",
        kind: item.values.kind ?? "",
        // The code is the model's, whose sentence the catalog holds; the English is a fallback.
        detail:
          errorCode && tErrors.has(errorCode)
            ? tErrors(errorCode, item.values)
            : (item.values.message ?? ""),
      })
    : item.action === "update" && item.fields.length > 0
      ? t("updatedFields", { fields: item.fields.join(", ") })
      : undefined;
  return (
    <ListItem
      label={item.label}
      description={
        <VStack gap={1}>
          {reason && (
            <Text type="body" size="sm" color="secondary">
              {reason}
            </Text>
          )}
          {item.kept.length > 0 && (
            <Text type="body" size="sm" color="secondary">
              {t("keptFields", { fields: item.kept.join(", ") })}
            </Text>
          )}
          {item.changes.length > 0 && (
            <Collapsible
              defaultIsOpen={false}
              trigger={
                <Text type="label" size="sm">
                  {t("showChanges")}
                </Text>
              }
            >
              <AuditChanges changes={item.changes} layout="unified" />
            </Collapsible>
          )}
        </VStack>
      }
      startContent={
        <Token size="sm" label={t(`actions.${item.action}`)} color={ACTION_COLOR[item.action]} />
      }
      endContent={
        <Text type="code" size="sm" color="secondary">
          {item.table}
        </Text>
      }
    />
  );
}

function ImportCard() {
  const t = useTranslations("settings.configTransfer");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");
  const [file, setFile] = useState<File | null>(null);
  const [described, setDescribed] = useState<Described | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<ConfigImportPreview | null>(null);
  const [done, setDone] = useState<ConfigImportPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  const send = async (step: "describe" | "preview" | "apply", chosen = file) => {
    if (!chosen) return null;
    const form = new FormData();
    form.set("file", chosen);
    form.set("step", step);
    form.set("passphrase", passphrase);
    const response = await fetch("/api/config/import", { method: "POST", body: form });
    if (!response.ok) throw await failureOf(response, tErrors("configImportFailed"));
    return await response.json();
  };
  const failed = (cause: unknown): Failure =>
    cause && typeof cause === "object" && "message" in cause && "reauth" in cause
      ? (cause as Failure)
      : { message: tErrors("configImportFailed"), reauth: false };

  const choose = async (chosen: File | null) => {
    setFile(chosen);
    setDescribed(null);
    setPreview(null);
    setDone(null);
    setError(null);
    if (!chosen) return;
    try {
      setDescribed((await send("describe", chosen)) as Described);
    } catch (cause) {
      setError(failed(cause));
    }
  };

  const run = async (step: "preview" | "apply") => {
    setBusy(true);
    setError(null);
    try {
      const result = (await send(step)) as ConfigImportPreview;
      if (step === "apply") {
        setDone(result);
        setPreview(null);
      } else {
        setPreview(result);
      }
    } catch (cause) {
      setError(failed(cause));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const listed = preview?.items.filter((item) => item.reason !== "unchanged") ?? [];
  const unchanged = (preview?.items.length ?? 0) - listed.length;
  const actionable = (preview?.counts.create ?? 0) + (preview?.counts.update ?? 0);

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <Heading level={3} accessibilityLevel={2}>
          {t("importTitle")}
        </Heading>
        <Text type="body" size="sm" color="secondary">
          {t("importHelp")}
        </Text>
        {error && <FailureBanner failure={error} title={tErrors("configImportFailed")} />}
        {done && (
          <Banner
            status="success"
            title={t("imported", {
              create: done.counts.create,
              update: done.counts.update,
              skip: done.counts.skip,
            })}
          />
        )}
        <FileInput
          label={t("chooseFile")}
          accept=".json,application/json"
          value={file}
          onChange={(chosen) => choose(Array.isArray(chosen) ? (chosen[0] ?? null) : chosen)}
        />

        {described && (
          <VStack gap={3}>
            <MetadataList>
              <MetadataListItem label={t("exportedAt")}>
                <Timestamp value={described.exportedAt} style="dateTimeShort" />
              </MetadataListItem>
              <MetadataListItem label={t("exportedBy")}>{described.appVersion}</MetadataListItem>
              <MetadataListItem label={t("rows")}>
                {Object.values(described.counts).reduce((sum, count) => sum + count, 0)}
              </MetadataListItem>
            </MetadataList>
            <TextInput
              startIcon={KeyRound}
              {...AUTOFILL_OFF}
              label={t("filePassphrase")}
              type="password"
              value={passphrase}
              onChange={setPassphrase}
              width="100%"
            />
            <Button
              variant="secondary"
              icon={<ScanSearch />}
              label={t("preview")}
              onClick={() => run("preview")}
              isLoading={busy && !confirmOpen}
              isDisabled={passphrase.length < MIN_PASSPHRASE || busy}
            />
          </VStack>
        )}

        {preview && (
          <VStack gap={3}>
            <Heading level={4} accessibilityLevel={3}>
              {t("previewHeading")}
            </Heading>
            <HStack gap={2} wrap="wrap">
              {(["create", "update", "skip"] as const).map((action) => (
                <Token
                  key={action}
                  size="sm"
                  color={ACTION_COLOR[action]}
                  label={t(`counts.${action}`, { count: preview.counts[action] })}
                />
              ))}
            </HStack>
            {actionable === 0 && <Text color="secondary">{t("nothingToDo")}</Text>}
            {listed.length > 0 && (
              <List density="compact" hasDividers>
                {listed.map((item) => (
                  <ItemLine key={`${item.table}:${item.label}`} item={item} />
                ))}
              </List>
            )}
            {unchanged > 0 && (
              <Text type="body" size="sm" color="secondary">
                {t("unchangedHidden", { count: unchanged })}
              </Text>
            )}
            {preview.warnings.length > 0 && (
              <Banner
                status="warning"
                title={t("warningsHeading")}
                description={preview.warnings
                  .map((warning) => t(`warnings.${warning.code}`, warning.values))
                  .join(" ")}
              />
            )}
            <Button
              icon={<Upload />}
              label={tCommon("import")}
              isDisabled={actionable === 0 || busy}
              onClick={() => setConfirmOpen(true)}
            />
          </VStack>
        )}

        <AlertDialog
          isOpen={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={t("confirmTitle")}
          description={t("confirmHelp")}
          actionLabel={tCommon("import")}
          onAction={() => run("apply")}
        />
      </VStack>
    </Card>
  );
}

/** Below backup and restore on the same page: the two are easy to confuse, so they sit together. */
export function ConfigTransfer() {
  const t = useTranslations("settings.configTransfer");
  return (
    <VStack gap={4}>
      <VStack gap={1}>
        {/* Settings search links here. */}
        <Heading level={2} id="portable-config">
          {t("heading")}
        </Heading>
        <Text type="body" size="sm" color="secondary">
          {t("intro")}
        </Text>
      </VStack>
      <ExportCard />
      <ImportCard />
    </VStack>
  );
}
