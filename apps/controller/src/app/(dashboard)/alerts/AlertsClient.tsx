"use client";

/**
 * Alerts: what is watched (rules), where it goes (channels), what went out (history) and the daily
 * summaries (digests). Every change goes through ./actions; the overview reloads after each.
 */

import { useCallback, useState } from "react";
import { useTabRoute } from "@/components/ui/useTabRoute";
import { useTranslations } from "next-intl";
import { VStack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { unwrap } from "@/src/lib/errors/action-result";
import { type AlertsOverview, loadAlertsOverviewAction } from "./actions";
import { ChannelsTab } from "./ChannelsTab";
import { DigestsTab } from "./DigestsTab";
import { HistoryTab } from "./HistoryTab";
import { RulesTab } from "./RulesTab";

const TABS = ["rules", "channels", "history", "digests"] as const;
type TabId = (typeof TABS)[number];

export default function AlertsClient({ initial }: { initial: AlertsOverview }) {
  const t = useTranslations("alerts");
  const tNav = useTranslations("nav");
  const [overview, setOverview] = useState(initial);
  const [tab, setTab] = useTabRoute("/alerts", TABS, "rules");
  const reload = useCallback(() => {
    loadAlertsOverviewAction()
      .then(unwrap)
      .then(setOverview, (error: unknown) => {
        console.error("Failed to reload the alerts:", error);
      });
  }, []);

  return (
    <VStack gap={6}>
      <ListPageHeader
        title={tNav("alerts")}
        filters={
          <TabList role="tablist" value={tab} onChange={(value) => setTab(value as TabId)}>
            {TABS.map((id) => (
              <Tab key={id} value={id} label={t(`tabs.${id}`)} />
            ))}
          </TabList>
        }
      />
      {tab === "rules" && <RulesTab overview={overview} onChanged={reload} />}
      {tab === "channels" && <ChannelsTab channels={overview.channels} onChanged={reload} />}
      {tab === "history" && <HistoryTab overview={overview} />}
      {tab === "digests" && <DigestsTab overview={overview} onChanged={reload} />}
    </VStack>
  );
}
