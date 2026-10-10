"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { CalendarDays, Download } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { NATIVE_REQUIRED } from "@/components/ui/native-input-attrs";
import { AppDialog } from "@/components/ui/AppDialog";
import { passwordPolicyHint, passwordPolicyMessage } from "@/src/lib/auth/password/policy-message";
import type { CaCertificate } from "@/lib/models/ca-certificates";
import type { IssuedClientCertificate } from "@/lib/models/issued-client-certificates";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { GeneratedPasswordField } from "@/src/components/ui/GeneratedPasswordField";
import { useFormatter, useTranslations } from "next-intl";
import { TIMESTAMP_STYLES, UtcTooltip } from "@/components/ui/Timestamp";
import {
  deleteCaCertificateAction,
  issueClientCertificateAction,
  revokeIssuedClientCertificateAction,
} from "@/src/app/(dashboard)/certificates/ca-actions";
import { unwrap } from "@/src/lib/errors/action-result";

function downloadFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function sanitizeFilenameSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "") || "client"
  );
}

function formatDateTime(format: ReturnType<typeof useFormatter>, value: string): string {
  return format.dateTime(new Date(value), TIMESTAMP_STYLES.dateTimeShort);
}

function formatFingerprint(value: string): string {
  return value.match(/.{1,2}/g)?.join(":") ?? value;
}

export function IssueClientCertDialog({
  open,
  cert,
  onClose,
}: {
  open: boolean;
  cert: CaCertificate;
  onClose: () => void;
}) {
  const t = useTranslations("caCertificates");
  const tSettings = useTranslations("settings");
  const tCertificates = useTranslations("certificates");
  const tCommon = useTranslations("common");
  // Unscoped as well, for the password rule - it is shared with every other password field.
  const tRoot = useTranslations();
  const router = useRouter();
  // Closed <dialog>s stay in the DOM, so a shared form id would resolve to the first (empty) form.
  const issueFormId = useId();
  const [isPending, startTransition] = useTransition();
  const [issued, setIssued] = useState<{
    pkcs12Base64: string;
    name: string;
    passwordProtected: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commonName, setCommonName] = useState("");
  const [validityDays, setValidityDays] = useState(365);
  const [exportPassword, setExportPassword] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  // So a reopened dialog does not show the previous export password.
  useEffect(() => {
    if (!open) return;
    setCommonName("");
    setValidityDays(365);
    setExportPassword("");
  }, [open]);

  function handleClose() {
    setIssued(null);
    setError(null);
    onClose();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const formData = new FormData(formRef.current!);
    setError(null);

    // Also server-side; this saves a 4096-bit keygen for a password that would be refused.
    const policyError = passwordPolicyMessage(
      tRoot,
      exportPassword,
      tRoot("passwordPolicy.subject.exportPassword"),
    );
    if (policyError) {
      setError(policyError);
      return;
    }

    startTransition(async () => {
      try {
        const result = unwrap(await issueClientCertificateAction(cert.id, formData));
        setIssued({
          ...result,
          name: sanitizeFilenameSegment(String(formData.get("common_name") ?? "client")),
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("issueFailed"));
      }
    });
  }

  const actions = issued ? (
    <Button label={tCommon("done")} onClick={handleClose} />
  ) : (
    <>
      <Button
        variant="secondary"
        label={tCommon("cancel")}
        onClick={handleClose}
        isDisabled={isPending}
      />
      <Button
        type="submit"
        form={issueFormId}
        variant="primary"
        label={tCommon("issue")}
        isLoading={isPending}
        isDisabled={isPending}
      />
    </>
  );

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title={t("issueClientCertificate")}
      maxWidth="sm"
      actions={actions}
    >
      {issued ? (
        <VStack gap={4}>
          <Banner
            status="success"
            title={t("clientCertificateIssued")}
            description={t("certificateDownloadWarning")}
          />
          <Text type="body" size="sm" color="secondary">
            {t("exportFormatHelp")}
          </Text>
          <Button
            variant="secondary"
            icon={<Download />}
            label={tCommon("download")}
            onClick={() =>
              downloadFile(
                `${issued.name}.p12`,
                new Blob([decodeBase64(issued.pkcs12Base64)], { type: "application/x-pkcs12" }),
              )
            }
          />
          {issued.passwordProtected && (
            <Text type="body" size="sm" color="secondary">
              {t("certificateImportHelp")}
            </Text>
          )}
        </VStack>
      ) : (
        <form id={issueFormId} ref={formRef} onSubmit={handleSubmit}>
          <VStack gap={4}>
            <TextInput
              {...NATIVE_REQUIRED}
              label={tCertificates("commonNameCn")}
              htmlName="common_name"
              value={commonName}
              onChange={setCommonName}
              isRequired
              hasAutoFocus
              placeholder={t("commonNamePlaceholder")}
              description={t("commonNameHelp")}
            />
            <NumberInput
              startIcon={CalendarDays}
              hasNumberSteppers
              label={tCertificates("validity")}
              htmlName="validity_days"
              value={validityDays}
              onChange={setValidityDays}
              min={1}
              max={3650}
              isIntegerOnly
              units={tSettings("units.days")}
            />
            <GeneratedPasswordField
              label={t("exportPassword")}
              htmlName="export_password"
              value={exportPassword}
              onChange={setExportPassword}
              isRequired
              description={t("p12PasswordHelp", { policy: passwordPolicyHint(tRoot) })}
            />
            {error && (
              <Banner status="error" title={t("couldNotIssueCertificate")} description={error} />
            )}
          </VStack>
        </form>
      )}
    </AppDialog>
  );
}

export function ManageIssuedClientCertsDialog({
  open,
  cert,
  issuedCerts,
  onClose,
}: {
  open: boolean;
  cert: CaCertificate;
  issuedCerts: IssuedClientCertificate[];
  onClose: () => void;
}) {
  const t = useTranslations("caCertificates");
  const tCommon = useTranslations("common");
  const tCertificates = useTranslations("certificates");
  const format = useFormatter();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [items, setItems] = useState<IssuedClientCertificate[]>(issuedCerts);
  const [error, setError] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setItems(issuedCerts);
    setError(null);
  }, [issuedCerts, open]);

  function handleRevoke(id: number) {
    setError(null);
    startTransition(async () => {
      try {
        const result = unwrap(await revokeIssuedClientCertificateAction(id));
        setItems((current) =>
          current.map((item) =>
            item.id === id
              ? { ...item, revokedAt: result.revokedAt, updatedAt: result.revokedAt }
              : item,
          ),
        );
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("revokeFailed"));
      }
    });
  }

  const visibleItems = showRevoked ? items : items.filter((i) => !i.revokedAt);
  const revokedCount = items.filter((i) => i.revokedAt).length;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={tCertificates("issuedClientCertificates")}
      maxWidth="md"
      actions={
        <Button
          variant="secondary"
          label={tCommon("close")}
          onClick={onClose}
          isDisabled={isPending}
        />
      }
    >
      <VStack gap={4}>
        <Banner
          status="info"
          title={t("revokeWarningTitle")}
          description={t("revokeWarningDescription", { name: cert.name })}
        />
        {error && (
          <Banner status="error" title={t("couldNotRevokeCertificate")} description={error} />
        )}
        {revokedCount > 0 && (
          <Switch
            label={t("showRevokedCount", { count: revokedCount })}
            value={showRevoked}
            onChange={setShowRevoked}
          />
        )}
        {visibleItems.length === 0 ? (
          <Text type="body" size="sm" color="secondary">
            {items.length === 0 ? t("issuedCertificatesEmpty") : t("activeCertificatesEmpty")}
          </Text>
        ) : (
          visibleItems.map((item) => {
            const expired = new Date(item.validTo).getTime() < Date.now();
            return (
              <Card key={item.id}>
                <VStack gap={3}>
                  <HStack justify="between" gap={4} vAlign="start">
                    <VStack gap={0}>
                      <Text type="body" weight="semibold">
                        {item.commonName}
                      </Text>
                      <Text type="body" size="sm" color="secondary">
                        {t("serialLine", { serial: item.serialNumber })}
                      </Text>
                    </VStack>
                    <HStack gap={1} wrap="wrap" justify="end">
                      <Badge
                        variant={item.revokedAt ? "neutral" : "success"}
                        label={item.revokedAt ? t("revoked") : t("active")}
                      />
                      <UtcTooltip value={item.validTo}>
                        <Badge
                          variant={expired ? "error" : "neutral"}
                          label={
                            expired
                              ? tCommon("expiredOn", { date: formatDateTime(format, item.validTo) })
                              : tCommon("expiresOn", { date: formatDateTime(format, item.validTo) })
                          }
                        />
                      </UtcTooltip>
                    </HStack>
                  </HStack>
                  <UtcTooltip value={item.createdAt}>
                    <Text type="body" size="sm" color="secondary">
                      {t("issuedLine", { date: formatDateTime(format, item.createdAt) })}
                    </Text>
                  </UtcTooltip>
                  <Text type="code" size="sm" color="secondary">
                    {t("fingerprintLine", {
                      fingerprint: formatFingerprint(item.fingerprintSha256),
                    })}
                  </Text>
                  {item.revokedAt ? (
                    <UtcTooltip value={item.revokedAt}>
                      <Text type="body" size="sm" color="secondary">
                        {t("revokedLine", { date: formatDateTime(format, item.revokedAt) })}
                      </Text>
                    </UtcTooltip>
                  ) : (
                    <HStack justify="end">
                      <Button
                        variant="destructive"
                        label={t("revoke")}
                        isLoading={isPending}
                        isDisabled={isPending}
                        onClick={() => handleRevoke(item.id)}
                      />
                    </HStack>
                  )}
                </VStack>
              </Card>
            );
          })
        )}
      </VStack>
    </AppDialog>
  );
}

export function DeleteCaCertDialog({
  open,
  cert,
  onClose,
}: {
  open: boolean;
  cert: CaCertificate;
  onClose: () => void;
}) {
  const t = useTranslations("caCertificates");
  const tCommon = useTranslations("common");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteCaCertificateAction(cert.id);
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("deleteCaCertificate")}
      maxWidth="sm"
      actions={
        <>
          <Button
            variant="secondary"
            label={tCommon("cancel")}
            onClick={onClose}
            isDisabled={isPending}
          />
          <Button
            variant="destructive"
            label={tCommon("delete")}
            onClick={handleDelete}
            isLoading={isPending}
            isDisabled={isPending}
          />
        </>
      }
    >
      <VStack gap={4}>
        <Text type="body" size="sm" color="secondary">
          {t.rich("deleteCaCertificateConfirm", {
            name: cert.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </Text>
        {error && (
          <Banner status="error" title={t("couldNotDeleteCertificate")} description={error} />
        )}
      </VStack>
    </AppDialog>
  );
}
