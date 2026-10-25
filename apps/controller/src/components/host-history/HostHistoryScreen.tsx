"use client";

import type { ComponentProps } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { ProxyHostHeader } from "@/components/proxy-hosts/detail/ProxyHostHeader";
import type { ProxyHostHeaderInfo } from "@/lib/proxy-hosts/header";
import { HostHistoryView } from "./HostHistoryView";
import { HostPageHeader } from "./HostPageHeader";
import { HostPageTabs } from "./HostPageTabs";

/** The history route's whole page: back to the list, the host's tabs, then its revisions. */
export function HostHistoryScreen({
  name,
  listHref,
  listLabel,
  overviewHref,
  editHref,
  historyHref,
  hostHeader = null,
  view,
}: {
  name: string;
  listHref: string;
  listLabel: string;
  overviewHref: string | null;
  editHref: string | null;
  historyHref: string;
  /** A live proxy host's, as its other tabs show it; others keep the history's own title. */
  hostHeader?: ProxyHostHeaderInfo | null;
  view: ComponentProps<typeof HostHistoryView>;
}) {
  const t = useTranslations("hostHistory");
  const tabs = (
    <HostPageTabs
      active="history"
      overviewHref={overviewHref}
      editHref={editHref}
      historyHref={historyHref}
    />
  );
  return (
    <VStack gap={5}>
      {hostHeader ? (
        <ProxyHostHeader header={hostHeader} tabs={tabs} />
      ) : (
        <HostPageHeader
          title={t("pageTitle", { name })}
          badge={!view.live && <Badge variant="error" label={t("deletedBadge")} />}
          listHref={listHref}
          listLabel={listLabel}
          tabs={tabs}
        />
      )}
      {view.latest === 0 ? (
        <Banner status="info" title={t("empty")} />
      ) : (
        <HostHistoryView {...view} />
      )}
    </VStack>
  );
}
