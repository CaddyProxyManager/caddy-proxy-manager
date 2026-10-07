"use client";

import { ArrowLeft } from "lucide-react";
import type { ComponentProps } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { HostHistoryView } from "./HostHistoryView";
import { HostPageTabs } from "./HostPageTabs";

/** The history route's whole page: back to the list, the host's tabs, then its revisions. */
export function HostHistoryScreen({
  name,
  listHref,
  listLabel,
  overviewHref,
  historyHref,
  view,
}: {
  name: string;
  listHref: string;
  listLabel: string;
  overviewHref: string | null;
  historyHref: string;
  view: ComponentProps<typeof HostHistoryView>;
}) {
  const t = useTranslations("hostHistory");
  return (
    <VStack gap={5}>
      <VStack gap={2}>
        <HStack>
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft />}
            label={listLabel}
            href={listHref}
          />
        </HStack>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Heading level={1}>{t("pageTitle", { name })}</Heading>
          {!view.live && <Badge variant="error" label={t("deletedBadge")} />}
        </HStack>
        <HostPageTabs active="history" overviewHref={overviewHref} historyHref={historyHref} />
      </VStack>
      {view.latest === 0 ? (
        <Banner status="info" title={t("empty")} />
      ) : (
        <HostHistoryView {...view} />
      )}
    </VStack>
  );
}
