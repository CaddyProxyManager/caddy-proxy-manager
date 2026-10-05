"use client";

import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useEmptyValue } from "@/components/ui/empty-value";
import { useFormatter, useTranslations } from "next-intl";
import { TIMESTAMP_STYLES } from "@/components/ui/Timestamp";
import { formatUtc } from "@/src/lib/locale/date-format";
import type { CertExpiryStatus } from "../page";

function formatRelative(
  t: ReturnType<typeof useTranslations<"certificates">>,
  validTo: string,
): string {
  const diff = new Date(validTo).getTime() - Date.now();
  const absDiff = Math.abs(diff);
  const days = Math.floor(absDiff / 86400000);
  const hours = Math.floor(absDiff / 3600000);

  if (diff < 0) {
    if (days >= 1) return t("expiredDaysAgo", { count: days });
    return t("expiredHoursAgo", { count: hours });
  }
  if (days >= 1) return t("expiresInDays", { count: days });
  return t("expiresInHours", { count: hours });
}

/** The expiry itself, on the reader's clock and in UTC: a certificate lapses at an instant. */
function formatFull(format: ReturnType<typeof useFormatter>, validTo: string): string {
  return `${format.dateTime(new Date(validTo), TIMESTAMP_STYLES.dateTimeShort)} · ${formatUtc(validTo)}`;
}

/** Icon and variant carry the meaning too, so expiry never reads by colour alone. */
const STATUS_CONFIG: Record<
  CertExpiryStatus,
  { variant: "error" | "warning" | "success"; icon: ReactNode }
> = {
  expired: { variant: "error", icon: <AlertCircle /> },
  expiring_soon: { variant: "warning", icon: <Clock /> },
  ok: { variant: "success", icon: <CheckCircle2 /> },
};

export function RelativeTime({
  validTo,
  status,
}: {
  validTo: string | null;
  status: CertExpiryStatus | null;
}) {
  const t = useTranslations("certificates");
  const format = useFormatter();
  const emptyValue = useEmptyValue();

  if (validTo === null || status === null) {
    return (
      <Text type="body" size="sm" color="secondary">
        {emptyValue}
      </Text>
    );
  }

  const config = STATUS_CONFIG[status];

  return (
    <Tooltip content={formatFull(format, validTo)}>
      <Badge variant={config.variant} icon={config.icon} label={formatRelative(t, validTo)} />
    </Tooltip>
  );
}
