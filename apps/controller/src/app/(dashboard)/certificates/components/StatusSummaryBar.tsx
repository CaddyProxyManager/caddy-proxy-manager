"use client";

import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { HStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";

type Props = {
  expired: number;
  expiringSoon: number;
  healthy: number;
  filter: string | null;
  onFilter: (f: string | null) => void;
};

/** The filter chips above the certificate tabs. ToggleButton owns the pressed state. */
const FILTERS: ReadonlyArray<{
  key: string;
  labelKey: "expired" | "expiringSoon" | "healthy";
  icon: ReactNode;
}> = [
  { key: "expired", labelKey: "expired", icon: <AlertCircle /> },
  { key: "expiring_soon", labelKey: "expiringSoon", icon: <Clock /> },
  { key: "ok", labelKey: "healthy", icon: <CheckCircle2 /> },
];

export function StatusSummaryBar({ expired, expiringSoon, healthy, filter, onFilter }: Props) {
  const t = useTranslations("certificates");
  const counts: Record<string, number> = {
    expired,
    expiring_soon: expiringSoon,
    ok: healthy,
  };

  return (
    <HStack gap={2} wrap="wrap">
      {FILTERS.map((f) => (
        <ToggleButton
          key={f.key}
          // The name carries the count the chip shows, or it no longer contains its visible text.
          label={t("statusFilter", { status: t(f.labelKey), count: counts[f.key] })}
          icon={f.icon}
          isPressed={filter === f.key}
          onPressedChange={(pressed) => onFilter(pressed ? f.key : null)}
        >
          <HStack gap={2} vAlign="center">
            <span>{t(f.labelKey)}</span>
            <Badge label={counts[f.key]} />
          </HStack>
        </ToggleButton>
      ))}
    </HStack>
  );
}
