"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  type DiffValue,
  type FieldChange,
  type HostChangeImpact,
  type HostChangePreview,
  type HostKind,
  MASKED_VALUE,
} from "@/lib/host-review/types";

type T = ReturnType<typeof useTranslations<"hostReview">>;

/** Field and section names come from the diff at runtime; tests/unit/host-review covers them. */
type Key = Parameters<T>[0];
const key = (value: string) => value as Key;

/** What an empty side means depends on the field: no agents is every agent, for one. */
function emptyLabel(field: string, t: T): string {
  if (field === "agentIds") return t("everyAgent");
  if (field === "certificateId") return t("automaticCertificate");
  if (field === "accessListId") return t("noAccessList");
  return t("notSet");
}

export function formatDiffValue(field: string, value: DiffValue, t: T): string {
  if (value === null || (Array.isArray(value) && value.length === 0)) return emptyLabel(field, t);
  if (value === MASKED_VALUE) return t("masked");
  if (value === true) return t("on");
  if (value === false) return t("off");
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  return String(value);
}

function ChangeDescription({ change, t }: { change: FieldChange; t: T }) {
  if (change.leaves) {
    return (
      <VStack gap={0.5}>
        {change.leaves.map((leaf) => (
          <Text key={leaf.path} type="supporting" size="sm" wordBreak="break-word">
            {t("leafLine", {
              path: leaf.path,
              before: formatDiffValue(leaf.path, leaf.before, t),
              after: formatDiffValue(leaf.path, leaf.after, t),
            })}
          </Text>
        ))}
      </VStack>
    );
  }
  return (
    <Text type="supporting" size="sm" wordBreak="break-word">
      {t("changeLine", {
        before: formatDiffValue(change.field, change.before, t),
        after: formatDiffValue(change.field, change.after, t),
      })}
    </Text>
  );
}

export type ReviewChangesDialogProps = {
  open: boolean;
  kind: HostKind;
  isCreate: boolean;
  preview: HostChangePreview | null;
  isLoading: boolean;
  /** The preview's refusal, or the save's when it fails from here. */
  error: string | null;
  reverted: readonly string[];
  isSaving: boolean;
  /** The policy holds this change for approval: saving submits it instead. */
  approval?: boolean;
  onUndo: (field: string) => void;
  onRestore: (field: string) => void;
  onEditSection: (section: string) => void;
  onBack: () => void;
  onSave: () => void;
};

export function ReviewChangesDialog({
  open,
  kind,
  isCreate,
  preview,
  isLoading,
  error,
  reverted,
  isSaving,
  approval = false,
  onUndo,
  onRestore,
  onEditSection,
  onBack,
  onSave,
}: ReviewChangesDialogProps) {
  const t = useTranslations("hostReview");
  const tCommon = useTranslations("common");
  const tApprovals = useTranslations("changeApprovals");
  const fieldLabel = (field: string) => t(key(`fields.${field}`));

  const changes = preview?.changes ?? [];
  const impact = preview?.impact;
  const nothingToSave = !isCreate && preview !== null && changes.length === 0;

  return (
    <AppDialog
      open={open}
      onClose={onBack}
      title={isCreate ? t("reviewCreateTitle") : t("reviewTitle")}
      maxWidth="lg"
      actions={
        <>
          <Button variant="secondary" label={tCommon("back")} onClick={onBack} />
          <Button
            variant="primary"
            label={approval ? tCommon("submit") : isCreate ? tCommon("create") : tCommon("save")}
            onClick={onSave}
            isLoading={isSaving}
            isDisabled={isSaving || isLoading || preview === null || nothingToSave}
          />
        </>
      }
    >
      <VStack gap={4}>
        {error && <Banner status="error" title={error} />}
        {approval && !isLoading && <Banner status="info" title={tApprovals("editorNotice")} />}
        {isLoading && <Spinner size="lg" label={t("loading")} />}
        {!isLoading && nothingToSave && <Text color="secondary">{t("noChanges")}</Text>}

        {!isLoading && changes.length > 0 && (
          <VStack gap={3}>
            <Text type="label" size="lg">
              {tCommon("changeCount", { count: changes.length })}
            </Text>
            {changes.some((change) => change.masked) && (
              <Text type="supporting" size="sm">
                {t("maskedNote")}
              </Text>
            )}
            <HostChangeList
              kind={kind}
              changes={changes}
              isSaving={isSaving}
              onUndo={onUndo}
              onEditSection={onEditSection}
            />
          </VStack>
        )}

        {reverted.length > 0 && (
          <VStack gap={2}>
            <Text type="label">{t("undoneHeading")}</Text>
            <Text type="supporting" size="sm">
              {t("undoneNote")}
            </Text>
            <List density="compact" hasDividers>
              {reverted.map((field) => (
                <ListItem
                  key={field}
                  label={fieldLabel(field)}
                  endContent={
                    <Button
                      variant="ghost"
                      size="sm"
                      label={tCommon("restore")}
                      tooltip={t("restoreLabel", { field: fieldLabel(field) })}
                      onClick={() => onRestore(field)}
                      isDisabled={isSaving}
                    />
                  }
                />
              ))}
            </List>
          </VStack>
        )}

        {!isLoading && impact && (changes.length > 0 || isCreate) && (
          <VStack gap={3}>
            <Divider />
            <HostImpactSummary kind={kind} impact={impact} />
          </VStack>
        )}
      </VStack>
    </AppDialog>
  );
}

/** Codes inside a warning's values (a protection, a sign-in kind, a mode) read in words. */
function translateValues(values: Record<string, string | number>, t: T) {
  const out: Record<string, string | number> = { ...values };
  if (typeof values.protection === "string") {
    out.protection = t(key(`protections.${values.protection}`));
  }
  for (const side of ["from", "to"] as const) {
    const value = values[side];
    if (typeof value !== "string") continue;
    if (["cpm", "authentik", "forwardAuth"].includes(value)) {
      out[side] = t(key(`signInKinds.${value}`));
    } else if (["inherit", "merge", "override"].includes(value)) {
      out[side] = t(key(`rateLimitModes.${value}`));
    }
  }
  return out;
}

/** The diff by editor section. Without callbacks it only reads, as an approver sees it. */
export function HostChangeList({
  kind,
  changes,
  isSaving = false,
  onUndo,
  onEditSection,
}: {
  kind: HostKind;
  changes: FieldChange[];
  isSaving?: boolean;
  onUndo?: (field: string) => void;
  onEditSection?: (section: string) => void;
}) {
  const t = useTranslations("hostReview");
  const tCommon = useTranslations("common");
  const sectionLabel = (section: string) => t(key(`sections.${kind}.${section}`));
  const fieldLabel = (field: string) => t(key(`fields.${field}`));
  const sections = [...new Set(changes.map((change) => change.section))];
  return (
    <>
      {sections.map((section) => (
        <List
          key={section}
          density="compact"
          hasDividers
          header={
            <HStack gap={2} justify="between" vAlign="center">
              <Text type="label">{sectionLabel(section)}</Text>
              {onEditSection && (
                <Button
                  variant="ghost"
                  size="sm"
                  label={t("editSection", { section: sectionLabel(section) })}
                  onClick={() => onEditSection(section)}
                />
              )}
            </HStack>
          }
        >
          {changes
            .filter((change) => change.section === section)
            .map((change) => (
              <ListItem
                key={change.field}
                label={fieldLabel(change.field)}
                description={<ChangeDescription change={change} t={t} />}
                endContent={
                  onUndo && change.revertible ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      label={tCommon("undo")}
                      tooltip={t("undoLabel", { field: fieldLabel(change.field) })}
                      onClick={() => onUndo(change.field)}
                      isDisabled={isSaving}
                    />
                  ) : undefined
                }
              />
            ))}
        </List>
      ))}
    </>
  );
}

/** What a save sets off: which agents reload, placement, certificates, and the warnings. */
export function HostImpactSummary({ kind, impact }: { kind: HostKind; impact: HostChangeImpact }) {
  const t = useTranslations("hostReview");
  const tAgents = useTranslations("agents");
  return (
    <VStack gap={3}>
      <Text type="label" size="lg">
        {t("impactHeading")}
      </Text>
      <List density="compact">
        <ListItem
          label={
            !impact.reload
              ? t("reloadNone")
              : impact.everyAgent
                ? t("reloadEveryAgent", { count: impact.agents.length })
                : t("reloadAgents", { count: impact.agents.length })
          }
          description={
            impact.reload && impact.agents.length > 0
              ? impact.agents
                  .map((agent) =>
                    agent.connected ? agent.name : t("agentOffline", { name: agent.name }),
                  )
                  .join(", ")
              : undefined
          }
        />
        <ListItem
          label={impact.pinned ? t("pinned") : tAgents("assignedToAll")}
          description={impact.pinChanged ? t("pinnedChanged") : undefined}
        />
        {kind === "http" && (
          <ListItem
            label={impact.certificates.length > 0 ? t("certificatesHeading") : t("noCertificates")}
            description={
              impact.certificates.length > 0
                ? impact.certificates
                    .map((cert) =>
                      cert.wildcard
                        ? t("certificateWildcard", { domain: cert.domain })
                        : t("certificateRequest", { domain: cert.domain }),
                    )
                    .join(", ")
                : undefined
            }
          />
        )}
      </List>
      {impact.warnings.map((warning) => (
        <Banner
          key={`${warning.code}:${JSON.stringify(warning.values)}`}
          status={warning.severity === "warning" ? "warning" : "info"}
          title={t(key(`warnings.${warning.code}`), translateValues(warning.values, t))}
        />
      ))}
    </VStack>
  );
}
