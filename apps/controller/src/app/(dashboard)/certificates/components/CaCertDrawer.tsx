"use client";

import { CalendarDays } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@astryxdesign/core/Button";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Stack";
import { NATIVE_REQUIRED } from "@/components/ui/native-input-attrs";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  createCaCertificateAction,
  generateCaCertificateAction,
  updateCaCertificateAction,
} from "../ca-actions";
import type { CaCertificateView } from "../page";
import { useTranslations } from "next-intl";

type Props = {
  open: boolean;
  cert: CaCertificateView | null;
  onClose: () => void;
};

/** One id per form, so each footer button submits the form it belongs to. */
const EDIT_FORM = "ca-cert-edit-form";
const GENERATE_FORM = "ca-cert-generate-form";
const IMPORT_FORM = "ca-cert-import-form";

export function CaCertDrawer({ open, cert, onClose }: Props) {
  const t = useTranslations("certificates");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const isEdit = cert !== null;
  const [tab, setTab] = useState<"generate" | "import">("generate");
  const [isPending, startTransition] = useTransition();
  const generateRef = useRef<HTMLFormElement>(null);
  const importRef = useRef<HTMLFormElement>(null);
  const editRef = useRef<HTMLFormElement>(null);

  const [editName, setEditName] = useState("");
  const [editPem, setEditPem] = useState("");
  const [genName, setGenName] = useState("");
  const [genCommonName, setGenCommonName] = useState("");
  const [genValidity, setGenValidity] = useState(3650);
  const [impName, setImpName] = useState("");
  const [impPem, setImpPem] = useState("");

  // Controlled inputs, so they need seeding on every open.
  useEffect(() => {
    if (!open) return;
    setEditName(cert?.name ?? "");
    setEditPem(cert?.certificatePem ?? "");
    setGenName("");
    setGenCommonName("");
    setGenValidity(3650);
    setImpName("");
    setImpPem("");
  }, [open, cert]);

  function handleClose() {
    setTab("generate");
    onClose();
  }

  function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    const formData = new FormData(generateRef.current!);
    startTransition(async () => {
      const result = await generateCaCertificateAction(formData);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      handleClose();
    });
  }

  function handleImport(e: React.FormEvent) {
    e.preventDefault();
    const formData = new FormData(importRef.current!);
    startTransition(async () => {
      const result = await createCaCertificateAction(formData);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      handleClose();
    });
  }

  function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    const formData = new FormData(editRef.current!);
    startTransition(async () => {
      const result = await updateCaCertificateAction(cert!.id, formData);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      handleClose();
    });
  }

  const activeForm = isEdit ? EDIT_FORM : tab === "generate" ? GENERATE_FORM : IMPORT_FORM;
  const submitLabel = isEdit
    ? tCommon("save")
    : tab === "generate"
      ? t("generateCaCertificate")
      : t("addCaCertificate");

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title={isEdit ? t("editCaCertificate") : t("addCaCertificate")}
      maxWidth="md"
      actions={
        <>
          <Button
            variant="secondary"
            label={tCommon("cancel")}
            onClick={handleClose}
            isDisabled={isPending}
          />
          {/* Wired by id because the footer lives outside the <form>. Which
              form it targets follows the selected tab. */}
          <Button
            type="submit"
            form={activeForm}
            label={submitLabel}
            isLoading={isPending}
            isDisabled={isPending}
          />
        </>
      }
    >
      {isEdit ? (
        <form id={EDIT_FORM} ref={editRef} onSubmit={handleEdit}>
          <VStack gap={4}>
            <TextInput
              {...NATIVE_REQUIRED}
              label={tCommon("name")}
              htmlName="name"
              value={editName}
              onChange={setEditName}
              isRequired
              hasAutoFocus
            />
            <TextArea
              {...NATIVE_REQUIRED}
              label={t("certificatePem")}
              htmlName="certificate_pem"
              value={editPem}
              onChange={setEditPem}
              isRequired
              rows={8}
              description={t("caCertificatePemHelp")}
            />
          </VStack>
        </form>
      ) : (
        <VStack gap={4}>
          <TabList
            value={tab}
            onChange={(v) => setTab(v as "generate" | "import")}
            layout="fill"
            hasDivider
          >
            <Tab value="generate" label={t("generate")} />
            <Tab value="import" label={t("importPem")} />
          </TabList>

          {tab === "generate" && (
            <form id={GENERATE_FORM} ref={generateRef} onSubmit={handleGenerate}>
              <VStack gap={4}>
                <TextInput
                  {...NATIVE_REQUIRED}
                  label={tCommon("name")}
                  htmlName="name"
                  value={genName}
                  onChange={setGenName}
                  isRequired
                  hasAutoFocus
                  placeholder={t("caNamePlaceholder")}
                  description={t("caNameHelp")}
                />
                <TextInput
                  label={t("commonNameCn")}
                  htmlName="common_name"
                  value={genCommonName}
                  onChange={setGenCommonName}
                  placeholder={t("caNamePlaceholder")}
                  description={t("commonNameHelp")}
                />
                <NumberInput
                  startIcon={CalendarDays}
                  hasNumberSteppers
                  label={t("validity")}
                  htmlName="validity_days"
                  value={genValidity}
                  onChange={setGenValidity}
                  min={1}
                  max={3650}
                  isIntegerOnly
                  units={tSettings("units.days")}
                />
              </VStack>
            </form>
          )}

          {tab === "import" && (
            <form id={IMPORT_FORM} ref={importRef} onSubmit={handleImport}>
              <VStack gap={4}>
                <TextInput
                  {...NATIVE_REQUIRED}
                  label={tCommon("name")}
                  htmlName="name"
                  value={impName}
                  onChange={setImpName}
                  isRequired
                  hasAutoFocus
                  placeholder={t("caNamePlaceholder")}
                />
                <TextArea
                  {...NATIVE_REQUIRED}
                  label={t("certificatePem")}
                  htmlName="certificate_pem"
                  value={impPem}
                  onChange={setImpPem}
                  isRequired
                  rows={8}
                  placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                  description={t("caCertificateHelp")}
                />
              </VStack>
            </form>
          )}
        </VStack>
      )}
    </AppDialog>
  );
}
