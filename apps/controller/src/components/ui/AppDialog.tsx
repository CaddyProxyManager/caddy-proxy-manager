"use client";

import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { HStack } from "@astryxdesign/core/Stack";
import { Button } from "@astryxdesign/core/Button";
import { useTranslations } from "next-intl";

type AppDialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: "xs" | "sm" | "md" | "lg" | "xl";
  actions?: ReactNode;
  submitLabel?: string;
  onSubmit?: () => void;
  isSubmitting?: boolean;
  /** Gates the submit button on form validity, independent of isSubmitting. */
  isSubmitDisabled?: boolean;
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
}: AppDialogProps) {
  const t = useTranslations("ui");
  useReturnFocus(open);
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      width={DIALOG_WIDTH[maxWidth]}
      // "form" keeps a backdrop click from discarding half-entered input.
      purpose="form"
    >
      <Layout
        header={<DialogHeader title={title} onOpenChange={() => onClose()} />}
        content={<LayoutContent>{children}</LayoutContent>}
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              {actions ?? (
                <>
                  <Button variant="secondary" label={t("cancel")} onClick={onClose} />
                  {onSubmit && (
                    <Button
                      // Astryx defaults to secondary, the same grey as Cancel beside it.
                      variant="primary"
                      label={submitLabel ?? t("save")}
                      onClick={onSubmit}
                      isLoading={isSubmitting}
                      isDisabled={isSubmitting || isSubmitDisabled}
                    />
                  )}
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
