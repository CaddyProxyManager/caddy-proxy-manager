"use client";

/**
 * Needs attention, rendered: one row per item, worst first, each linking to where it is fixed.
 * Shared by the overview and the host page. Item text comes from `attention.items.<code>`.
 */

import { CircleCheck } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import {
  type AttentionList as AttentionListData,
  type AttentionSeverity,
  attentionMessageValues,
} from "@/lib/attention/types";

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
}: {
  list: AttentionListData;
  emptyTitle?: string;
}) {
  const t = useTranslations("attention");
  // The one place the keys are composed at runtime; tests/unit/attention covers the catalog.
  const tItem = t as unknown as DynamicTranslate;

  if (list.items.length === 0) {
    if (!emptyTitle) return null;
    return (
      <VStack gap={2}>
        <EmptyState title={emptyTitle} icon={<CircleCheck />} isCompact />
        {list.skipped.length > 0 && (
          <Text type="body" size="xsm" color="secondary">
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
          const values = attentionMessageValues(item);
          return (
            <ListItem
              key={item.id}
              label={tItem(`items.${item.code}.title`, values)}
              description={tItem(`items.${item.code}.detail`, values)}
              href={item.href ?? undefined}
              startContent={
                <StatusDot variant={DOT[item.severity]} label={t(`severity.${item.severity}`)} />
              }
              endContent={
                <Badge variant={BADGE[item.severity]} label={t(`severity.${item.severity}`)} />
              }
            />
          );
        })}
      </List>
      {(list.skipped.length > 0 || list.truncated > 0) && (
        <Text type="body" size="xsm" color="secondary">
          {list.truncated > 0 ? t("truncated", { count: list.truncated }) : null}
          {list.truncated > 0 && list.skipped.length > 0 ? " " : null}
          {list.skipped.length > 0 ? t("skipped", { count: list.skipped.length }) : null}
        </Text>
      )}
    </VStack>
  );
}
