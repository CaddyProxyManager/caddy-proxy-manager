"use client";

import type { ReactNode } from "react";
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
