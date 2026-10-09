"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import {
  acknowledgeAttentionAction,
  loadAttentionAction,
} from "@/src/app/(dashboard)/overview-actions";
import { AttentionList } from "@/components/attention/AttentionList";
import {
  type AttentionItem,
  type AttentionList as AttentionListData,
  hasAttentionToShow,
  type OverviewAttention,
} from "@/lib/attention/types";

/**
 * Loads after the page, since a provider may use its whole budget. Absent until there is something
 * to say: an item, a check that ran out of time, or a load that failed. `preview` is the docs',
 * where acknowledging only hides the item here.
 */
export function NeedsAttentionCard({ preview }: { preview?: AttentionListData }) {
  const t = useTranslations("attention");
  const [data, setData] = useState<OverviewAttention | null>(
    preview ? { list: preview, acknowledged: 0, canAcknowledge: true } : null,
  );
  const [failed, setFailed] = useState(false);
  const list = data?.list ?? null;

  useEffect(() => {
    if (preview) return;
    let live = true;
    loadAttentionAction()
      .then((loaded) => {
        if (!live) return;
        if (loaded) setData(loaded);
        else setFailed(true);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [preview]);

  const hide = (item: AttentionItem) =>
    setData(
      (current) =>
        current && {
          ...current,
          list: { ...current.list, items: current.list.items.filter((i) => i.id !== item.id) },
          acknowledged: current.acknowledged + 1,
        },
    );

  const acknowledge = (item: AttentionItem) => {
    hide(item);
    if (preview) return;
    void acknowledgeAttentionAction(item.id, item.code).then((result) => {
      if (result.status === "error") {
        toast.error(result.message);
        loadAttentionAction().then((loaded) => loaded && setData(loaded));
      }
    });
  };

  if (!failed && (!list || !hasAttentionToShow(list))) return null;
  const critical = list?.items.filter((item) => item.severity === "critical").length ?? 0;

  return (
    <Card padding={5}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2}>
          <HStack gap={2} vAlign="center">
            <Icon icon={TriangleAlert} size="sm" color="accent" />
            <Heading level={2} accessibilityLevel={2}>
              {t("title")}
            </Heading>
          </HStack>
          {list && list.items.length > 0 && (
            <Badge
              variant={critical > 0 ? "error" : "warning"}
              label={t("count", { count: list.items.length + list.truncated })}
            />
          )}
        </HStack>
        {list ? (
          <AttentionList
            list={list}
            emptyTitle={t("empty")}
            onAcknowledge={data?.canAcknowledge ? acknowledge : undefined}
          />
        ) : (
          <Text type="body" size="sm" color="secondary">
            {t("loadFailed")}
          </Text>
        )}
        {data && data.acknowledged > 0 && (
          <Text type="body" size="sm" color="secondary">
            {t("acknowledgedHidden", { count: data.acknowledged })}
          </Text>
        )}
      </VStack>
    </Card>
  );
}
