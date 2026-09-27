"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import type { RegistryField } from "./RegistrySettingsBlock";

const DISMISSED_KEY = "cpm-forward-auth-sequential-ids-dismissed";

/** Upgrades are pinned to numeric ids by migration; without a nudge most would never switch. */
export function SequentialUserIdsBanner({ field }: { field?: RegistryField }) {
  const t = useTranslations("settings");
  // Hidden until mounted, so a dismissed banner does not flash in on hydration.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSED_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (field?.kind !== "boolean" || !field.value || dismissed) return null;

  return (
    <Banner
      status="info"
      title={t("forwardAuthSequentialIdsTitle")}
      description={t("forwardAuthSequentialIdsDescription", { setting: field.label })}
      isDismissable
      dismissLabel={t("forwardAuthSequentialIdsDismiss")}
      onDismiss={() => {
        setDismissed(true);
        try {
          localStorage.setItem(DISMISSED_KEY, "1");
        } catch {
          /* ignore */
        }
      }}
    />
  );
}
