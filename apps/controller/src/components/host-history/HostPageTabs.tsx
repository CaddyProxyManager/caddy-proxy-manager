"use client";

import { Tab, TabList } from "@astryxdesign/core/TabList";
import { useTranslations } from "next-intl";

/** Links between a host's pages, not panels: each tab is its own route. */
export function HostPageTabs({
  active,
  overviewHref,
  analyticsHref = null,
  logsHref = null,
  editHref,
  historyHref,
}: {
  active: "overview" | "analytics" | "logs" | "edit" | "history";
  /** Null for a host with no page of its own (layer 4, or deleted). */
  overviewHref: string | null;
  /** A proxy host's, for those who may read its analytics and logs. */
  analyticsHref?: string | null;
  logsHref?: string | null;
  /** Null for a deleted host. */
  editHref: string | null;
  /** Null for those who may not manage the host: its revisions name who changed it. */
  historyHref: string | null;
}) {
  const t = useTranslations("hostHistory");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const tSettings = useTranslations("settings");
  return (
    <TabList value={active} onChange={() => {}} hasDivider size="lg" className="cpm-page-tabs">
      {overviewHref && <Tab value="overview" label={t("overviewTab")} href={overviewHref} />}
      {analyticsHref && <Tab value="analytics" label={tNav("analytics")} href={analyticsHref} />}
      {logsHref && <Tab value="logs" label={tNav("logs")} href={logsHref} />}
      {editHref && <Tab value="edit" label={tCommon("edit")} href={editHref} />}
      {historyHref && (
        <Tab value="history" label={tSettings("history.navLabel")} href={historyHref} />
      )}
    </TabList>
  );
}
