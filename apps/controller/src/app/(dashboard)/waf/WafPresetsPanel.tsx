"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Plus } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { CodeEditor } from "@/components/ui/CodeEditor";
import { useSeclangIssues } from "@/components/ui/seclang-issues";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { NATIVE_REQUIRED } from "@/components/ui/native-input-attrs";
import { Timestamp } from "@/components/ui/Timestamp";
import { INITIAL_ACTION_STATE } from "@/lib/errors/action-error";
import { deleteWafPresetAction, saveWafPresetAction } from "./actions";

export type WafPresetRow = {
  id: number;
  name: string;
  description: string | null;
  directives: string;
  updatedAt: string;
  usedGlobally: boolean;
  usedByDashboard: boolean;
  hostCount: number;
};

export function WafPresetsPanel({
  presets,
  strictDirectives,
}: {
  presets: WafPresetRow[];
  /** The global setting as the form shows it, so the editor's markers match what a save does. */
  strictDirectives: boolean;
}) {
  const t = useTranslations("waf");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  const router = useRouter();
  // null: closed. "new": creating. A row: editing it.
  const [editing, setEditing] = useState<WafPresetRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<WafPresetRow | null>(null);

  const usageLabel = (row: WafPresetRow) => {
    const parts: string[] = [];
    if (row.usedGlobally) parts.push(t("presetUsedGlobally"));
    if (row.usedByDashboard) parts.push(tSettings("dashboardHostTitle"));
    if (row.hostCount > 0) parts.push(tCommon("hostCount", { count: row.hostCount }));
    return parts;
  };

  const columns: Column<WafPresetRow>[] = [
    {
      id: "name",
      label: tCommon("name"),
      render: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold">
            {row.name}
          </Text>
          {row.description && (
            <Text type="body" size="sm" color="secondary" maxLines={1}>
              {row.description}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      id: "usage",
      label: tCommon("usedBy"),
      width: 220,
      render: (row) => {
        const labels = usageLabel(row);
        return labels.length === 0 ? (
          <Text type="body" size="sm" color="secondary">
            {t("presetUnused")}
          </Text>
        ) : (
          <HStack gap={1} wrap="wrap">
            {labels.map((label) => (
              <Badge key={label} label={label} />
            ))}
          </HStack>
        );
      },
    },
    {
      id: "updatedAt",
      label: t("presetUpdatedAt"),
      width: 200,
      render: (row) => (
        <Text type="body" size="sm" color="secondary">
          <Timestamp value={row.updatedAt} />
        </Text>
      ),
    },
    {
      id: "actions",
      label: tCommon("actions"),
      width: 64,
      align: "right",
      render: (row) => (
        <DropdownMenu
          hasChevron={false}
          alignment="end"
          button={{
            variant: "ghost",
            icon: <MoreHorizontal />,
            label: tCommon("actionsFor", { name: row.name }),
            isIconOnly: true,
          }}
          items={[
            { id: "edit", label: tCommon("edit"), onClick: () => setEditing(row) },
            { id: "delete", label: tCommon("delete"), onClick: () => setDeleting(row) },
          ]}
        />
      ),
    },
  ];

  return (
    // gap 6, as the list pages have: the table bleeds up by the container padding to meet it.
    <VStack gap={6}>
      <HStack justify="between" vAlign="start" gap={3} wrap="wrap">
        <VStack gap={1}>
          <Heading level={2}>{t("presets")}</Heading>
          <Text type="body" size="sm" color="secondary">
            {t("presetsDescription")}
          </Text>
        </VStack>
        {presets.length > 0 && (
          <Button
            variant="primary"
            icon={<Plus />}
            label={tCommon("new")}
            onClick={() => setEditing("new")}
          />
        )}
      </HStack>

      {presets.length === 0 ? (
        <EmptyState
          title={t("presetsEmptyTitle")}
          description={t("presetsEmptyDescription")}
          actions={
            <Button
              variant="primary"
              icon={<Plus />}
              label={tCommon("new")}
              onClick={() => setEditing("new")}
            />
          }
        />
      ) : (
        <DataTable columns={columns} data={presets} keyField="id" />
      )}

      <WafPresetDialog
        preset={editing}
        strictDirectives={strictDirectives}
        onClose={() => setEditing(null)}
        onSaved={(message) => {
          setEditing(null);
          toast.success(message);
          router.refresh();
        }}
      />

      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("presetDelete")}
        description={deleting ? t("presetDeleteConfirm", { name: deleting.name }) : ""}
        actionLabel={t("presetDelete")}
        onAction={async () => {
          if (!deleting) return;
          const result = await deleteWafPresetAction(deleting.id);
          setDeleting(null);
          if (result.status === "error") {
            toast.error(result.message);
            return;
          }
          toast.success(result.message);
          router.refresh();
        }}
      />
    </VStack>
  );
}

function WafPresetDialog({
  preset,
  strictDirectives,
  onClose,
  onSaved,
}: {
  preset: WafPresetRow | "new" | null;
  strictDirectives: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("waf");
  const tCommon = useTranslations("common");
  const existing = preset === "new" ? null : preset;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [directives, setDirectives] = useState("");
  const directiveIssues = useSeclangIssues(directives, { strictDirectives });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formId = "waf-preset-form";

  useEffect(() => {
    if (preset === null) return;
    setName(existing?.name ?? "");
    setDescription(existing?.description ?? "");
    setDirectives(existing?.directives ?? "");
    setError(null);
  }, [preset, existing]);

  return (
    <AppDialog
      open={preset !== null}
      onClose={onClose}
      title={existing ? tCommon("editNamed", { name: existing.name }) : t("presetNew")}
      maxWidth="lg"
      submitLabel={existing ? tCommon("save") : tCommon("create")}
      isSubmitting={submitting}
      isSubmitDisabled={name.trim() === "" || directives.trim() === ""}
      onSubmit={() => (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit()}
    >
      <form
        id={formId}
        action={async (formData) => {
          setSubmitting(true);
          try {
            const result = await saveWafPresetAction(INITIAL_ACTION_STATE, formData);
            if (result.status === "error") setError(result.message ?? null);
            else onSaved(result.message ?? "");
          } finally {
            setSubmitting(false);
          }
        }}
      >
        {existing && <input type="hidden" name="id" value={existing.id} />}
        <VStack gap={3}>
          {error && <Banner status="error" title={error} />}
          {existing &&
            (existing.usedGlobally || existing.usedByDashboard || existing.hostCount > 0) && (
              <Banner status="info" title={t("presetEditAppliesEverywhere")} />
            )}
          <TextInput
            {...NATIVE_REQUIRED}
            label={tCommon("name")}
            htmlName="name"
            value={name}
            onChange={setName}
            isRequired
            hasAutoFocus
          />
          <TextInput
            label={tCommon("description")}
            isOptional
            htmlName="description"
            value={description}
            onChange={setDescription}
          />
          <CodeEditor
            label={t("presetDirectives")}
            language="seclang"
            htmlName="directives"
            height="md"
            value={directives}
            onChange={setDirectives}
            issues={directiveIssues}
            placeholder={t("presetDirectivesPlaceholder")}
            description={t("presetDirectivesHelp")}
          />
        </VStack>
      </form>
    </AppDialog>
  );
}
