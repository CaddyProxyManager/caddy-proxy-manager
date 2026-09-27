"use client";

/** On every settings screen: one change set spans sections, and a per-page bar would hide half. */

import { useState, useTransition } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Banner } from "@astryxdesign/core/Banner";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DiffLine } from "@/src/lib/settings/config-diff";
import type { RevisionRow } from "@/src/lib/settings/apply";
import { settingsHref } from "./sections";
import { sectionForStorageKey, stagedChangeLabel } from "@/src/lib/settings/section-keys";
import type { StagedView } from "@/src/lib/settings/staged-view";
import { applyStagedSettingsAction, discardStagedSettingsAction } from "./actions";

/** In the header, so the apply control has one address and covers no form field. */
export function StagedControls({ view }: { view: StagedView }) {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (view.changes.length === 0) return null;

  const discardAll = () => {
    startTransition(async () => {
      await discardStagedSettingsAction();
      router.refresh();
    });
  };

  return (
    <HStack gap={2} vAlign="center" data-testid="staged-bar">
      <Button
        variant="ghost"
        size="sm"
        label={t("stagedDiscard")}
        onClick={discardAll}
        isDisabled={pending}
      />
      <Button
        size="sm"
        label={t("stagedReview")}
        endContent={<Badge variant="warning" label={String(view.changes.length)} />}
        onClick={() => setOpen(true)}
      />
      <ReviewSheet view={view} open={open} onClose={() => setOpen(false)} />
    </HStack>
  );
}

/** Which configuration Caddy runs, and whether the last apply got there. */
export function RevisionPill({ staged }: { staged: StagedView }) {
  const t = useTranslations("settings");
  if (staged.currentRevision === null) {
    return (
      <Text type="supporting" color="secondary">
        {t("revisionNever")}
      </Text>
    );
  }
  const latest = staged.revisions[0];
  return (
    <Link href="/settings/history" aria-label={t("history.viewAll")}>
      <Badge
        variant={latest?.outcome === "failed" ? "error" : "success"}
        label={t("revisionPill", { id: staged.currentRevision })}
      />
    </Link>
  );
}

function ReviewSheet({
  view,
  open,
  onClose,
}: {
  view: StagedView;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const apply = () => {
    setError(null);
    startTransition(async () => {
      const result = await applyStagedSettingsAction();
      if (!result.success) {
        setError(result.message ?? null);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  const undo = (key: string) => {
    startTransition(async () => {
      await discardStagedSettingsAction(key);
      router.refresh();
    });
  };

  const next = view.currentRevision === null ? 1 : view.currentRevision + 1;

  return (
    <Dialog isOpen={open} onOpenChange={(isOpen) => !isOpen && onClose()} width={1000}>
      <DialogHeader title={t("reviewTitle")} onOpenChange={(isOpen) => !isOpen && onClose()} />
      <VStack gap={4} padding={4}>
        <Text type="supporting" color="secondary">
          {t("reviewSubtitle", { from: view.currentRevision ?? 0, to: next })}
        </Text>

        {error && <Banner status="error" title={error} />}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 360px) minmax(0, 1fr)",
            gap: "var(--spacing-4)",
            alignItems: "start",
          }}
        >
          <VStack gap={3}>
            <Heading level={3}>{t("reviewChangeCount", { count: view.changes.length })}</Heading>
            <Divider />
            {view.changes.map((change) => (
              <HStack key={change.key} gap={2} vAlign="start">
                <VStack gap={0} style={{ flexGrow: 1, minWidth: 0 }}>
                  {/* A way back to the block it came from. */}
                  {change.sectionId ? (
                    <Link href={settingsHref(change.sectionId)} onClick={onClose}>
                      {stagedChangeLabel(t, change)}
                    </Link>
                  ) : (
                    <Text type="label">{stagedChangeLabel(t, change)}</Text>
                  )}
                  {change.fields.length > 0 ? (
                    // One link per field, back to the control.
                    <HStack gap={2} wrap="wrap">
                      {change.fields.map((field) => (
                        <Link
                          key={field}
                          href={`${settingsHref(change.sectionId ?? "")}?field=${encodeURIComponent(field)}`}
                          onClick={onClose}
                        >
                          <Text type="supporting">{field}</Text>
                        </Link>
                      ))}
                    </HStack>
                  ) : (
                    <Text type="supporting" color="secondary">
                      {change.key}
                    </Text>
                  )}
                </VStack>
                <Button
                  variant="ghost"
                  size="sm"
                  label={t("reviewUndo")}
                  onClick={() => undo(change.key)}
                  isDisabled={pending}
                />
              </HStack>
            ))}

            {view.revisions.length > 0 && (
              <>
                <Divider />
                <HStack gap={2} vAlign="center">
                  <Heading level={5}>{t("reviewHistoryTitle")}</Heading>
                  <div style={{ flexGrow: 1 }} />
                  <Link href="/settings/history" onClick={onClose}>
                    <Text type="supporting">{t("history.viewAll")}</Text>
                  </Link>
                </HStack>
                {view.revisions.map((revision) => (
                  <HStack key={revision.id} gap={2} vAlign="center">
                    <Text type="code" size="xsm" color="secondary">
                      #{revision.id}
                    </Text>
                    <Text type="supporting" color="secondary" maxLines={1}>
                      {revisionSummary(t, format, revision)}
                    </Text>
                    <div style={{ flexGrow: 1 }} />
                    {revision.outcome === "failed" && (
                      <Badge variant="error" label={t("revisionFailed")} />
                    )}
                  </HStack>
                ))}
              </>
            )}
          </VStack>

          <VStack gap={2}>
            <HStack gap={2} vAlign="center">
              <Heading level={3}>{t("reviewTabConfig")}</Heading>
              <div style={{ flexGrow: 1 }} />
              <Text type="supporting" color="secondary">
                {t("reviewDiffStat", { added: view.diff.added, removed: view.diff.removed })}
              </Text>
            </HStack>
            <Divider />
            {view.diff.unchanged ? (
              <Banner status="info" title={t("reviewNoConfigChange")} />
            ) : (
              <>
                <DiffView lines={view.diff.lines} />
                <Text type="supporting" color="secondary">
                  {t("reviewSecretsMasked")}
                </Text>
              </>
            )}
          </VStack>
        </div>

        <Divider />
        <HStack gap={2} justify="end" vAlign="center">
          {pending && <Spinner size="sm" />}
          <Button
            variant="secondary"
            label={t("reviewClose")}
            onClick={onClose}
            isDisabled={pending}
          />
          <Button
            label={pending ? t("reviewApplying") : t("reviewApply")}
            onClick={apply}
            isDisabled={pending}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
}

/** The stored summary is raw storage keys, so it shows only when the keys column is unreadable. */
export function revisionSummary(
  t: ReturnType<typeof useTranslations<"settings">>,
  format: ReturnType<typeof useFormatter>,
  revision: RevisionRow,
): string {
  if (revision.keys.length === 0) return revision.summary;
  const labels = revision.keys.map((key) => {
    const known = sectionForStorageKey(key);
    return stagedChangeLabel(t, { sectionId: known?.id ?? null, label: known?.label ?? key });
  });
  // Several keys can belong to one section; it is named once.
  return format.list(new Set(labels), { type: "unit" });
}

/** Status tokens, so the diff follows the theme. */
const DIFF_BACKGROUND: Record<DiffLine["kind"], string | undefined> = {
  added: "var(--color-success-muted)",
  removed: "var(--color-error-muted)",
  context: undefined,
  gap: "var(--color-background-muted)",
};

export function DiffView({ lines }: { lines: DiffLine[] }) {
  const t = useTranslations("settings");
  return (
    <div
      style={{
        maxHeight: 420,
        overflow: "auto",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-inner)",
        fontFamily: "var(--font-family-code)",
        fontSize: "var(--font-size-sm)",
        lineHeight: 1.7,
      }}
      data-testid="config-diff"
    >
      {lines.map((line, index) => (
        <div
          // Text recurs and the list is replaced wholesale, so no state can follow a reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the only identity a diff line has
          key={`${index}-${line.kind}`}
          style={{
            display: "flex",
            gap: "var(--spacing-2)",
            padding: "0 var(--spacing-2)",
            background: DIFF_BACKGROUND[line.kind],
            whiteSpace: "pre",
          }}
        >
          <span style={{ width: 44, flexShrink: 0, color: "var(--color-text-secondary)" }}>
            {line.line ?? ""}
          </span>
          <span
            style={{
              color:
                line.kind === "gap" ? "var(--color-text-secondary)" : "var(--color-text-primary)",
            }}
          >
            {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
            {line.kind === "gap"
              ? ` ${t("reviewUnchangedLines", { count: line.skipped ?? 0 })} `
              : line.text}
          </span>
        </div>
      ))}
    </div>
  );
}
