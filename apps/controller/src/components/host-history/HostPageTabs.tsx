"use client";

import { Tab, TabList } from "@astryxdesign/core/TabList";
import { useTranslations } from "next-intl";

/** Links between a host's pages, not panels: each tab is its own route. */
export function HostPageTabs({
  active,
  overviewHref,
  historyHref,
}: {
  active: "overview" | "history";
  /** Null for a host with no page of its own (layer 4, or deleted). */
  overviewHref: string | null;
  historyHref: string;
}) {
  const t = useTranslations("hostHistory");
  const tSettings = useTranslations("settings");
  return (
    <TabList value={active} onChange={() => {}} hasDivider>
      {overviewHref && <Tab value="overview" label={t("overviewTab")} href={overviewHref} />}
      <Tab value="history" label={tSettings("history.navLabel")} href={historyHref} />
    </TabList>
  );
}
