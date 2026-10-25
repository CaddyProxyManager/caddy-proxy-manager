"use client";

import { Tab, TabList } from "@astryxdesign/core/TabList";
import { useTranslations } from "next-intl";

/** Links between a host's pages, not panels: each tab is its own route. */
export function HostPageTabs({
  active,
  overviewHref,
  editHref,
  historyHref,
}: {
  active: "overview" | "edit" | "history";
  /** Null for a host with no page of its own (layer 4, or deleted). */
  overviewHref: string | null;
  /** Null for a deleted host. */
  editHref: string | null;
  historyHref: string;
}) {
  const t = useTranslations("hostHistory");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  return (
    <TabList value={active} onChange={() => {}} hasDivider size="lg" className="cpm-page-tabs">
      {overviewHref && <Tab value="overview" label={t("overviewTab")} href={overviewHref} />}
      {editHref && <Tab value="edit" label={tCommon("edit")} href={editHref} />}
      <Tab value="history" label={tSettings("history.navLabel")} href={historyHref} />
    </TabList>
  );
}
