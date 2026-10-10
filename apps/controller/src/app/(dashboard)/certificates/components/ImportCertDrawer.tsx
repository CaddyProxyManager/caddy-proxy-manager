"use client";

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import type { CertificateFileEntry } from "@cpm/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { NATIVE_REQUIRED } from "@/components/ui/native-input-attrs";
import { AppDialog } from "@/components/ui/AppDialog";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import {
  createCertificateAction,
  createCertificateFromFilesAction,
  listCertificateFilesAction,
  updateCertificateAction,
} from "../actions";
import type {
  CertificateFileAgent,
  DnsProviderChoice,
  ImportedCertView,
  ManagedCertView,
} from "../page";
import { useFormatter, useTranslations } from "next-intl";

type Props = {
  open: boolean;
  /** A managed certificate is only ever edited here; the dialog imports. */
  cert: ImportedCertView | ManagedCertView | null;
  fileAgents: CertificateFileAgent[];
  dnsProviders: DnsProviderChoice[];
  onClose: () => void;
};

type Source = "upload" | "agent-file";

const FORM_ID = "import-cert-form";
/** The select's value for "no override"; no Caddy DNS module is named this. */
const DEFAULT_DNS_PROVIDER = "default";

/** certbot's pair first, then the usual names beside the certificate. Empty when unsure. */
export function pairedKeyPath(certPath: string, entries: CertificateFileEntry[]): string {
  const keys = entries.filter((entry) => entry.kind === "key").map((entry) => entry.path);
  const slash = certPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : certPath.slice(0, slash + 1);
  const stem = certPath.replace(/\.[^./]+$/, "");
  const guesses = [`${dir}privkey.pem`, `${dir}key.pem`, `${stem}.key`, `${stem}-key.pem`];
  const guess = guesses.find((candidate) => keys.includes(candidate));
  if (guess) return guess;
  const beside = keys.filter((key) => key.startsWith(dir) && !key.slice(dir.length).includes("/"));
  return beside.length === 1 ? (beside[0] ?? "") : "";
}

/** certbot's `live/<name>/fullchain.pem` when there is one, else the first certificate. */
export function defaultCertificatePath(entries: CertificateFileEntry[]): string {
  const certs = entries.filter((entry) => entry.kind === "certificate");
  const preferred =
    certs.find(
      (entry) => entry.path.startsWith("live/") && entry.path.endsWith("/fullchain.pem"),
    ) ??
    certs.find((entry) => entry.path.endsWith("fullchain.pem")) ??
    certs[0];
  return preferred?.path ?? "";
}

export function ImportCertDrawer({ open, cert, fileAgents, dnsProviders, onClose }: Props) {
  const t = useTranslations("certificates");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const isEdit = cert !== null;
  const isManaged = cert?.type === "managed";
  const file = cert?.type === "imported" ? cert.file : null;
  const isFileCert = file != null;
  const [isPending, startTransition] = useTransition();
  const [source, setSource] = useState<Source>("upload");
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [dnsProvider, setDnsProvider] = useState(DEFAULT_DNS_PROVIDER);
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [agentId, setAgentId] = useState("");
  const [entries, setEntries] = useState<CertificateFileEntry[] | null>(null);
  const [isListing, startListing] = useTransition();
  const [certPath, setCertPath] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  // The inputs are controlled, so opening the dialog has to seed them.
  useEffect(() => {
    if (!open) return;
    setName(cert?.name ?? "");
    setDomains(cert?.domains.join("\n") ?? "");
    setDnsProvider((cert?.type === "managed" && cert.dnsProvider) || DEFAULT_DNS_PROVIDER);
    setCertPem("");
    setKeyPem("");
    setShowKey(false);
    setSource("upload");
    setError(null);
    setAgentId("");
    setEntries(null);
    setCertPath("");
    setKeyPath("");
  }, [open, cert]);

  function handleClose() {
    setShowKey(false);
    onClose();
  }

  function chooseCertificate(path: string, list: CertificateFileEntry[]) {
    setCertPath(path);
    setKeyPath(pairedKeyPath(path, list));
    const chosen = list.find((entry) => entry.path === path);
    if (chosen?.kind === "certificate" && chosen.names[0]) {
      setName((current) => current || (chosen.names[0] ?? ""));
    }
  }

  function chooseAgent(next: string) {
    setAgentId(next);
    setEntries(null);
    setCertPath("");
    setKeyPath("");
    setError(null);
    startListing(async () => {
      const result = await listCertificateFilesAction(Number(next));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const list = result.data;
      setEntries(list);
      const first = defaultCertificatePath(list);
      if (first) chooseCertificate(first, list);
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const formData = new FormData(formRef.current!);
    setError(null);
    startTransition(async () => {
      const result = isEdit
        ? await updateCertificateAction(cert.id, formData)
        : source === "agent-file"
          ? await createCertificateFromFilesAction({
              name,
              agentRowId: Number(agentId),
              certPath,
              keyPath,
            })
          : await createCertificateAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      handleClose();
    });
  }

  function readFile(file: File | File[] | null, setter: (v: string) => void) {
    const single = Array.isArray(file) ? file[0] : file;
    if (!single) return;
    const reader = new FileReader();
    reader.onload = (e) => setter(e.target?.result as string);
    reader.readAsText(single);
  }

  const certificateOptions = (entries ?? []).flatMap((entry) =>
    entry.kind === "certificate"
      ? [
          {
            value: entry.path,
            label: entry.path,
            description: t("fileNamesExpire", {
              names: entry.names.join(", "),
              date: format.dateTime(new Date(entry.notAfter), { dateStyle: "medium" }),
            }),
          },
        ]
      : [],
  );
  const keyOptions = (entries ?? []).flatMap((entry) =>
    entry.kind === "key" ? [{ value: entry.path, label: entry.path }] : [],
  );
  const fromFiles = !isEdit && source === "agent-file";
  const canSubmit = !fromFiles || (agentId !== "" && certPath !== "" && keyPath !== "");

  const domainsField = (
    <TextArea
      {...NO_SPELLCHECK}
      label={t("domainsOnePerLine")}
      htmlName="domain_names"
      value={domains}
      onChange={setDomains}
      rows={3}
      description={t("certificateDomainsHelp")}
    />
  );

  // An override whose credentials were since removed stays listed, so it can be seen and cleared.
  const stored = cert?.type === "managed" ? cert.dnsProvider : null;
  const dnsProviderOptions = [
    { value: DEFAULT_DNS_PROVIDER, label: t("dnsProviderDefault") },
    ...dnsProviders.map((provider) => ({ value: provider.name, label: provider.displayName })),
    ...(stored && !dnsProviders.some((provider) => provider.name === stored)
      ? [{ value: stored, label: t("dnsProviderMissing", { name: stored }) }]
      : []),
  ];

  const managedFields = (
    <>
      {domainsField}
      <Selector
        label={t("dnsProvider")}
        description={t("dnsProviderHelp")}
        options={dnsProviderOptions}
        value={dnsProvider}
        onChange={setDnsProvider}
        hasSearch={dnsProviderOptions.length > 8}
      />
      {/* The marker tells the action the field was shown, so the default choice clears. */}
      <input type="hidden" name="dns_provider_present" value="1" />
      <input
        type="hidden"
        name="dns_provider"
        value={dnsProvider === DEFAULT_DNS_PROVIDER ? "" : dnsProvider}
      />
    </>
  );

  const uploadFields = (
    <>
      {domainsField}

      <VStack gap={2}>
        <TextArea
          label={t("certificatePem")}
          htmlName="certificate_pem"
          placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
          rows={6}
          value={certPem}
          onChange={setCertPem}
          description={t("certificateChainHelp")}
        />
        <FileInput
          label={t("loadCertificateFromFile")}
          isLabelHidden
          accept=".pem,.crt,.cer,.txt"
          value={null}
          onChange={(f) => readFile(f, setCertPem)}
        />
      </VStack>

      <VStack gap={2}>
        <HStack gap={2} vAlign="start">
          {/* The mask is a CSS wrapper, not input type=password: a password
              input strips newlines on paste and would corrupt the PEM. */}
          <div data-masked-input={showKey ? "false" : "true"} className="flex-1">
            <TextArea
              label={t("privateKeyPem")}
              htmlName="private_key_pem"
              placeholder={
                showKey ? "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----" : "••••••••"
              }
              rows={6}
              value={keyPem}
              onChange={setKeyPem}
              hasSpellCheck={false}
              width="100%"
              description={t("privateKeyWarning")}
            />
          </div>
          <IconButton
            variant="ghost"
            label={showKey ? t("hidePrivateKey") : t("showPrivateKey")}
            tooltip={showKey ? tCommon("hide") : tCommon("show")}
            icon={showKey ? <EyeOff /> : <Eye />}
            onClick={() => setShowKey((v) => !v)}
          />
        </HStack>
        <FileInput
          label={t("loadPrivateKeyLabel")}
          isLabelHidden
          accept=".pem,.key,.txt"
          value={null}
          onChange={(f) => readFile(f, setKeyPem)}
        />
      </VStack>
    </>
  );

  const fileFields =
    fileAgents.length === 0 ? (
      <Text type="body" size="sm" color="secondary">
        {t("noFileAgents")}
      </Text>
    ) : (
      <>
        <Selector
          label={tCommon("agent")}
          description={t("fileAgentHelp")}
          placeholder={t("fileAgentPlaceholder")}
          options={fileAgents.map((agent) => ({ value: String(agent.id), label: agent.name }))}
          value={agentId}
          onChange={chooseAgent}
        />
        {isListing && (
          <Text type="body" size="sm" color="secondary">
            {t("filesLoading")}
          </Text>
        )}
        {entries !== null && certificateOptions.length === 0 && (
          <Text type="body" size="sm" color="secondary">
            {t("filesEmpty")}
          </Text>
        )}
        {certificateOptions.length > 0 && (
          <>
            <Selector
              label={t("fileCertificate")}
              description={t("fileCertificateHelp")}
              placeholder={t("filePlaceholder")}
              options={certificateOptions}
              value={certPath}
              onChange={(next) => chooseCertificate(next, entries ?? [])}
              hasSearch={certificateOptions.length > 8}
            />
            <Selector
              label={t("fileKey")}
              description={t("fileKeyHelp")}
              placeholder={t("filePlaceholder")}
              options={keyOptions}
              value={keyPath}
              onChange={setKeyPath}
              hasSearch={keyOptions.length > 8}
            />
            <Text type="body" size="sm" color="secondary">
              {t("fileNamesFromCertificate")}
            </Text>
          </>
        )}
      </>
    );

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title={isEdit ? t("editCertificate") : t("importCertificate")}
      maxWidth="md"
      actions={
        <>
          <Button
            variant="secondary"
            label={tCommon("cancel")}
            onClick={handleClose}
            isDisabled={isPending}
          />
          {/* The footer sits outside the <form>, so the button is wired to it
              by id. That also restores implicit submission on Enter. */}
          <Button
            type="submit"
            form={FORM_ID}
            label={isEdit ? tCommon("save") : tCommon("import")}
            isLoading={isPending}
            isDisabled={isPending || !canSubmit}
          />
        </>
      }
    >
      <form id={FORM_ID} ref={formRef} onSubmit={handleSubmit}>
        <VStack gap={4}>
          <input type="hidden" name="type" value={isManaged ? "managed" : "imported"} />

          {!isEdit && (
            <SegmentedControl
              label={t("sourceLabel")}
              layout="fill"
              value={source}
              onChange={(next) => {
                setSource(next as Source);
                setError(null);
              }}
            >
              <SegmentedControlItem value="upload" label={t("sourceUpload")} />
              <SegmentedControlItem value="agent-file" label={t("sourceAgentFile")} />
            </SegmentedControl>
          )}

          {error && <Banner status="error" title={error} />}

          {fromFiles && fileFields}

          <TextInput
            {...NATIVE_REQUIRED}
            label={tCommon("name")}
            htmlName="name"
            value={name}
            onChange={setName}
            isRequired
            hasAutoFocus
            description={t("importedCertificateNameHelp")}
          />

          {file && (
            <Text type="body" size="sm" color="secondary">
              {t("fileSourcePaths", {
                agent: file.agentName ?? t("sourceDeletedAgent"),
                certPath: file.certPath ?? "",
                keyPath: file.keyPath ?? "",
              })}
            </Text>
          )}

          {isManaged ? managedFields : !fromFiles && !isFileCert && uploadFields}
        </VStack>
      </form>
    </AppDialog>
  );
}
