"use client";

import type { ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { useTranslations } from "next-intl";
import { AppDialog } from "./AppDialog";

/** Muted, so it reads as a temporary mode rather than the filters it replaces. */
export function BulkActionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  /** The actions, as Buttons or a MoreMenu; the toolbar sizes them. */
  children: ReactNode;
}) {
  const t = useTranslations("ui");
  const tCommon = useTranslations("common");
  return (
    <Toolbar
      label={t("bulk.label")}
      size="sm"
      variant="muted"
      gap={2}
      startContent={
        <>
          <Badge label={t("bulk.selectedCount", { count })} />
          {children}
        </>
      }
      endContent={<Button variant="ghost" label={tCommon("clearSelection")} onClick={onClear} />}
    />
  );
}

/** Names every row it will touch: a batch is easy to mis-select and a delete cannot be undone. */
export function BulkConfirmDialog({
  open,
  title,
  items,
  summary,
  isDestructive = false,
  confirmLabel,
  isPending,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  items: { id: number | string; name: string }[];
  /** The line above the list; says "hosts" when omitted. */
  summary?: string;
  isDestructive?: boolean;
  confirmLabel?: string;
  isPending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
  /** Whatever the action needs chosen first, such as the certificate to set. */
  children?: ReactNode;
}) {
  const t = useTranslations("ui");
  const tCommon = useTranslations("common");
  return (
    <AppDialog
      open={open}
      onClose={() => {
        if (!isPending) onClose();
      }}
      title={title}
      maxWidth="md"
      submitLabel={confirmLabel ?? tCommon("apply")}
      onSubmit={onConfirm}
      isSubmitting={isPending}
    >
      <VStack gap={4}>
        {error && <Banner status="error" title={error} />}
        {children}
        <Text type="body" size="sm">
          {summary ?? t("bulk.appliesTo", { count: items.length })}
        </Text>
        {/* A closed dialog stays mounted; "Delete unused" would otherwise hide every name in the page. */}
        {open && (
          <List density="compact" hasDividers>
            {items.map((item) => (
              <ListItem key={item.id} label={item.name} />
            ))}
          </List>
        )}
        {isDestructive && <Banner status="warning" title={t("bulk.cannotBeUndone")} />}
      </VStack>
    </AppDialog>
  );
}
