"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import type { ActionState } from "@/lib/errors/action-error";
import type { HostChangePreview, HostKind, HostPreviewResult } from "@/lib/host-review/types";
import { ReviewChangesDialog } from "./ReviewChangesDialog";
import { useUnsavedChanges } from "./useUnsavedChanges";

export type EditorSectionLink = { id: string; anchor: string };

function scrollToAnchor(anchor: string) {
  document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/** Ctrl+S, or Cmd+S on a Mac; nothing else. */
function isSaveShortcut(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "s"
  );
}

/**
 * The frame every host editor shares: section jumps, an unsaved-changes count beside the buttons,
 * a Review changes step (also on Ctrl/Cmd+S while the editor is open) and a confirmation before
 * closing over unsaved edits. Saving straight from the footer still works; the review is one step
 * away, never in the way.
 */
export function HostEditorShell({
  open,
  onClose,
  title,
  kind,
  isCreate,
  formId,
  submitLabel,
  state,
  isPending,
  preview,
  sections,
  onSectionLink,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  kind: HostKind;
  isCreate: boolean;
  formId: string;
  submitLabel: string;
  state: ActionState;
  isPending: boolean;
  preview: (formData: FormData) => Promise<HostPreviewResult>;
  sections: EditorSectionLink[];
  /** Puts a jumped-to section in the URL, where the editor can be opened on it again. */
  onSectionLink?: (section: string) => void;
  children: ReactNode;
}) {
  const t = useTranslations("hostReview");
  const tUi = useTranslations("ui");
  const sectionKey = (id: string) => `sections.${kind}.${id}` as Parameters<typeof t>[0];
  const unsaved = useUnsavedChanges(formId, open);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [result, setResult] = useState<HostChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [reverted, setReverted] = useState<string[]>([]);
  const [discardOpen, setDiscardOpen] = useState(false);
  // The action state a save from the review started from; a newer one is that save's answer.
  const submittedFrom = useRef<ActionState | null>(null);
  const request = useRef(0);

  const form = () => document.getElementById(formId) as HTMLFormElement | null;

  const runPreview = async (fields: string[]) => {
    const element = form();
    if (!element) return;
    const data = new FormData(element);
    data.delete("revertField");
    for (const field of fields) data.append("revertField", field);
    const id = ++request.current;
    setIsLoading(true);
    setError(null);
    try {
      const answer = await preview(data);
      if (id !== request.current) return;
      if (answer.ok) setResult(answer.preview);
      else {
        setResult(null);
        setError(answer.message);
      }
    } finally {
      if (id === request.current) setIsLoading(false);
    }
  };

  const openReview = () => {
    // The browser's own checks first: a review of a form that cannot be sent helps nobody.
    if (form()?.reportValidity() === false) return;
    setReverted([]);
    setResult(null);
    setReviewOpen(true);
    void runPreview([]);
  };

  const closeReview = () => {
    request.current += 1;
    setReviewOpen(false);
    setReverted([]);
    setIsLoading(false);
    submittedFrom.current = null;
  };

  const save = () => {
    submittedFrom.current = state;
    form()?.requestSubmit();
  };

  const changeReverted = (next: string[]) => {
    setReverted(next);
    void runPreview(next);
  };

  // The answer to a save started from the review: close on success, show a refusal in place.
  useEffect(() => {
    if (!reviewOpen || submittedFrom.current === null || state === submittedFrom.current) return;
    submittedFrom.current = null;
    if (state.status === "success") {
      setReviewOpen(false);
      setReverted([]);
    } else if (state.status === "error") {
      setError(state.message ?? null);
    }
  }, [state, reviewOpen]);

  const requestClose = () => {
    if (unsaved > 0 && state.status !== "success") setDiscardOpen(true);
    else onClose();
  };

  // Only while this editor is open, so the browser keeps Ctrl+S everywhere else.
  useEffect(() => {
    if (!open || discardOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      if (reviewOpen) {
        if (result && !isLoading && !isPending) save();
      } else {
        openReview();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!open || unsaved === 0 || state.status === "success") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [open, unsaved, state.status]);

  const jump = (section: EditorSectionLink) => {
    scrollToAnchor(section.anchor);
    onSectionLink?.(section.id);
  };

  return (
    <>
      <AppDialog
        open={open}
        onClose={requestClose}
        title={title}
        maxWidth="lg"
        footerStart={
          <Text type="supporting" size="sm" color={unsaved > 0 ? "primary" : "secondary"}>
            {unsaved > 0 ? t("unsaved", { count: unsaved }) : t("noUnsaved")}
          </Text>
        }
        actions={
          <>
            <Button variant="secondary" label={tUi("cancel")} onClick={requestClose} />
            <Button
              variant="secondary"
              label={t("reviewChanges")}
              tooltip={t("shortcutHint")}
              onClick={openReview}
              isDisabled={isPending}
            />
            <Button
              variant="primary"
              label={submitLabel}
              onClick={() => form()?.requestSubmit()}
              isLoading={isPending && !reviewOpen}
              isDisabled={isPending}
            />
          </>
        }
      >
        <VStack gap={4}>
          {sections.length > 1 && (
            <HStack gap={1} wrap="wrap" vAlign="center">
              <Text type="supporting" size="sm">
                {t("jumpTo")}
              </Text>
              {sections.map((section) => (
                <Button
                  key={section.id}
                  variant="ghost"
                  size="sm"
                  label={t(sectionKey(section.id))}
                  onClick={() => jump(section)}
                />
              ))}
            </HStack>
          )}
          {children}
          {reviewOpen &&
            reverted.map((field) => (
              <input key={field} type="hidden" name="revertField" value={field} form={formId} />
            ))}
        </VStack>
      </AppDialog>

      <ReviewChangesDialog
        open={reviewOpen}
        kind={kind}
        isCreate={isCreate}
        preview={result}
        isLoading={isLoading}
        error={error}
        reverted={reverted}
        isSaving={isPending}
        onUndo={(field) => changeReverted([...reverted, field])}
        onRestore={(field) => changeReverted(reverted.filter((f) => f !== field))}
        onEditSection={(id) => {
          closeReview();
          const section = sections.find((s) => s.id === id);
          if (section) setTimeout(() => jump(section), 50);
        }}
        onBack={closeReview}
        onSave={save}
      />

      <AlertDialog
        isOpen={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t("discardTitle")}
        description={t("discardDescription", { count: unsaved })}
        actionLabel={t("discardAction")}
        cancelLabel={t("keepEditing")}
        onAction={() => {
          setDiscardOpen(false);
          onClose();
        }}
      />
    </>
  );
}
