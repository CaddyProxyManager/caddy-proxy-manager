"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { loadAttentionAction } from "@/src/app/(dashboard)/overview-actions";
import { AttentionList } from "@/components/attention/AttentionList";
import type { AttentionList as AttentionListData } from "@/lib/attention/types";

/** Loads after the page, since a provider may use its whole budget. `preview` is the docs'. */
export function NeedsAttentionCard({ preview }: { preview?: AttentionListData }) {
  const t = useTranslations("attention");
  const [list, setList] = useState<AttentionListData | null>(preview ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (preview) return;
    let live = true;
    loadAttentionAction()
      .then((loaded) => {
        if (!live) return;
        if (loaded) setList(loaded);
        else setFailed(true);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [preview]);

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
          <AttentionList list={list} emptyTitle={t("empty")} />
        ) : failed ? (
          <Text type="body" size="sm" color="secondary">
            {t("loadFailed")}
          </Text>
        ) : (
          <Spinner label={t("loading")} size="sm" />
        )}
      </VStack>
    </Card>
  );
}
