"use client";

/**
 * Needs attention, rendered: one row per item, worst first, each linking to where it is fixed.
 * Shared by the overview and the host page. Item text comes from `attention.items.<code>`.
 */

import { Check, CircleCheck } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Button } from "@astryxdesign/core/Button";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import {
  type AttentionItem,
  type AttentionList as AttentionListData,
  type AttentionSeverity,
  attentionMessageValues,
} from "@/lib/attention/types";
import { attentionErrorText } from "@/lib/attention/error-text";

const DOT: Record<AttentionSeverity, "error" | "warning" | "neutral"> = {
  critical: "error",
  warning: "warning",
  info: "neutral",
};

const BADGE: Record<AttentionSeverity, "error" | "warning" | "info"> = {
  critical: "error",
  warning: "warning",
  info: "info",
};

type DynamicTranslate = (key: string, values?: Record<string, string | number | Date>) => string;

export function AttentionList({
  list,
  /** Shown when there is nothing; omit to render nothing at all. */
  emptyTitle,
  /** Offers to hide each item; the overview's, not the host page's. */
  onAcknowledge,
}: {
  list: AttentionListData;
  emptyTitle?: string;
  onAcknowledge?: (item: AttentionItem) => void;
}) {
  const t = useTranslations("attention");
  // For an error stored with its code, said in the reader's language rather than the English.
  const tRoot = useTranslations();
  // The one place the keys are composed at runtime; tests/unit/attention covers the catalog.
  const tItem = t as unknown as DynamicTranslate;

  if (list.items.length === 0) {
    if (!emptyTitle) return null;
    return (
      <VStack gap={2}>
        <EmptyState title={emptyTitle} icon={<CircleCheck />} isCompact />
        {list.skipped.length > 0 && (
          <Text type="body" size="sm" color="secondary">
            {t("skipped", { count: list.skipped.length })}
          </Text>
        )}
      </VStack>
    );
  }

  return (
    <VStack gap={2}>
      <List hasDividers density="compact">
        {list.items.map((item) => {
          const values = {
            ...attentionMessageValues(item),
            ...(item.errors?.length && { error: attentionErrorText(tRoot, item.errors) }),
          };
          const title = tItem(`items.${item.code}.title`, values);
          const badge = (
            <Badge variant={BADGE[item.severity]} label={t(`severity.${item.severity}`)} />
          );
          return (
            <ListItem
              key={item.id}
              label={title}
              description={tItem(`items.${item.code}.detail`, values)}
              href={item.href ?? undefined}
              startContent={
                <StatusDot variant={DOT[item.severity]} label={t(`severity.${item.severity}`)} />
              }
              endContent={
                onAcknowledge ? (
                  <HStack gap={2} vAlign="center">
                    {badge}
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Check />}
                      label={t("acknowledge")}
                      aria-label={t("acknowledgeItem", { title })}
                      onClick={() => onAcknowledge(item)}
                    />
                  </HStack>
                ) : (
                  badge
                )
              }
            />
          );
        })}
      </List>
      {(list.skipped.length > 0 || list.truncated > 0) && (
        <Text type="body" size="sm" color="secondary">
          {list.truncated > 0 ? t("truncated", { count: list.truncated }) : null}
          {list.truncated > 0 && list.skipped.length > 0 ? " " : null}
          {list.skipped.length > 0 ? t("skipped", { count: list.skipped.length }) : null}
        </Text>
      )}
    </VStack>
  );
}
