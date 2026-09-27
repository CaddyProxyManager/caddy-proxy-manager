"use client";

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { NATIVE_REQUIRED } from "@/components/ui/native-input-attrs";
import { AppDialog } from "@/components/ui/AppDialog";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { createCertificateAction, updateCertificateAction } from "../actions";
import type { ImportedCertView } from "../page";
import { useTranslations } from "next-intl";

type Props = {
  open: boolean;
  cert: ImportedCertView | null;
  onClose: () => void;
};

const FORM_ID = "import-cert-form";

export function ImportCertDrawer({ open, cert, onClose }: Props) {
  const t = useTranslations("certificates");
  const isEdit = cert !== null;
  const [isPending, startTransition] = useTransition();
  const [showKey, setShowKey] = useState(false);
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  // The inputs are controlled, so opening the dialog has to seed them.
  useEffect(() => {
    if (!open) return;
    setName(cert?.name ?? "");
    setDomains(cert?.domains.join("\n") ?? "");
    setCertPem("");
    setKeyPem("");
    setShowKey(false);
  }, [open, cert]);

  function handleClose() {
    setShowKey(false);
    onClose();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const formData = new FormData(formRef.current!);
    startTransition(async () => {
      if (isEdit) {
        await updateCertificateAction(cert.id, formData);
      } else {
        await createCertificateAction(formData);
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
            label={t("cancel")}
            onClick={handleClose}
            isDisabled={isPending}
          />
          {/* The footer sits outside the <form>, so the button is wired to it
              by id. That also restores implicit submission on Enter. */}
          <Button
            type="submit"
            form={FORM_ID}
            label={isEdit ? t("saveChanges") : t("importCertificate")}
            isLoading={isPending}
            isDisabled={isPending}
          />
        </>
      }
    >
      <form id={FORM_ID} ref={formRef} onSubmit={handleSubmit}>
        <VStack gap={4}>
          <input type="hidden" name="type" value="imported" />

          <TextInput
            {...NATIVE_REQUIRED}
            label={t("name")}
            htmlName="name"
            value={name}
            onChange={setName}
            isRequired
            hasAutoFocus
            description={t("importedCertificateNameHelp")}
          />

          <TextArea
            {...NO_SPELLCHECK}
            label={t("domainsOnePerLine")}
            htmlName="domain_names"
            value={domains}
            onChange={setDomains}
            rows={3}
            description={t("certificateDomainsHelp")}
          />

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
              <div data-masked-input={showKey ? "false" : "true"} style={{ flex: 1 }}>
                <TextArea
                  label={t("privateKeyPem")}
                  htmlName="private_key_pem"
                  placeholder={
                    showKey
                      ? "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
                      : "••••••••"
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
                tooltip={showKey ? t("hide") : t("show")}
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
        </VStack>
      </form>
    </AppDialog>
  );
}
