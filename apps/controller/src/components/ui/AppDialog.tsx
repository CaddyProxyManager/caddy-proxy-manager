"use client";

import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Button } from "@astryxdesign/core/Button";
import { useTranslations } from "next-intl";

type AppDialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: "xs" | "sm" | "md" | "lg" | "xl";
  /** Null leaves the footer out: the editor that reviews before it saves has no buttons there. */
  actions?: ReactNode | null;
  submitLabel?: string;
  onSubmit?: () => void;
  isSubmitting?: boolean;
  /** Gates the submit button on form validity, independent of isSubmitting. */
  isSubmitDisabled?: boolean;
  /** Pinned under the title rather than scrolled with the content: a Toolbar, which brings its own divider. */
  subheader?: ReactNode;
};

const DIALOG_WIDTH: Record<NonNullable<AppDialogProps["maxWidth"]>, number> = {
  xs: 320,
  sm: 420,
  md: 560,
  lg: 720,
  xl: 960,
};

/**
 * Astryx's DialogHeader focuses its title in a mount effect. A dialog mounted already open (keyed,
 * or rendered conditionally) runs that before Dialog records the trigger, so Dialog would hand focus
 * back to its own closed title and a keyboard user would land on <body>. A layout effect sees the
 * trigger first; focus already in a dialog is StrictMode's second run, so the first one's stands.
 */
function useReturnFocus(open: boolean) {
  const trigger = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open && !document.activeElement?.closest("dialog"))
      trigger.current = document.activeElement;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    return () => {
      // Passive, so the timer starts in the same flush as Dialog's own close and fires after it.
      setTimeout(() => {
        // A closed dialog stays painted through its exit animation, keeping its title focused.
        const active = document.activeElement;
        const lost = !active || active === document.body || !!active.closest("dialog:not([open])");
        const target = trigger.current;
        if (lost && target instanceof HTMLElement && target.isConnected) target.focus();
      });
    };
  }, [open]);
}

export function AppDialog({
  open,
  onClose,
  title,
  children,
  maxWidth = "sm",
  actions,
  submitLabel,
  onSubmit,
  isSubmitting = false,
  isSubmitDisabled = false,
  subheader,
}: AppDialogProps) {
  const tCommon = useTranslations("common");
  useReturnFocus(open);
  const buttons =
    actions === null
      ? null
      : (actions ?? (
          <>
            <Button variant="secondary" label={tCommon("cancel")} onClick={onClose} />
            {onSubmit && (
              <Button
                // Astryx defaults to secondary, the same grey as Cancel beside it.
                variant="primary"
                label={submitLabel ?? tCommon("save")}
                onClick={onSubmit}
                isLoading={isSubmitting}
                isDisabled={isSubmitting || isSubmitDisabled}
              />
            )}
          </>
        ));
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      width={DIALOG_WIDTH[maxWidth]}
      // "form" keeps a backdrop click from discarding half-entered input.
      purpose="form"
    >
      <Layout
        header={
          subheader ? (
            <VStack gap={0}>
              <DialogHeader title={title} onOpenChange={() => onClose()} hasDivider={false} />
              {subheader}
            </VStack>
          ) : (
            <DialogHeader title={title} onOpenChange={() => onClose()} />
          )
        }
        content={<LayoutContent>{children}</LayoutContent>}
        footer={
          buttons === null ? undefined : (
            <LayoutFooter>
              <HStack gap={2} justify="end">
                {buttons}
              </HStack>
            </LayoutFooter>
          )
        }
      />
    </Dialog>
  );
}
