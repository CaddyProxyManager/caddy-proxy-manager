"use client";

/**
 * One country's slice of the traffic: to what, and how it was answered. Only columns the access log
 * records; there is no ASN column, so no breakdown by network.
 */

import { useEffect, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { X } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { regionName } from "@/src/lib/locale/region-names";

export type CountryBreakdownData = {
  countryCode: string;
  total: number;
  blocked: number;
  uniqueIps: number;
  hosts: { host: string; count: number }[];
  statusClasses: { ok: number; redirects: number; clientErrors: number; serverErrors: number };
  userAgents: { userAgent: string; count: number }[];
};

type Row = { label: string; count: number };

function RankedList({ title, rows, color }: { title: string; rows: Row[]; color: string }) {
  const format = useFormatter();
  const top = rows.reduce((max, row) => Math.max(max, row.count), 0);
  return (
    <VStack gap={2}>
      <Text type="supporting" color="secondary">
        {title}
      </Text>
      {rows.map((row) => (
        <VStack key={row.label} gap={1}>
          <HStack gap={2} vAlign="center" justify="between">
            <Text type="body" size="sm" maxLines={1}>
              {row.label}
            </Text>
            <Text type="code" size="xsm" color="secondary" hasTabularNumbers>
              {format.number(row.count)}
            </Text>
          </HStack>
          <div
            aria-hidden="true"
            style={{
              height: 4,
              borderRadius: 999,
              background: "var(--color-border)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: top > 0 ? `${(row.count / top) * 100}%` : 0,
                height: "100%",
                background: color,
              }}
            />
          </div>
        </VStack>
      ))}
    </VStack>
  );
}

/** Fetching is split from drawing so the docs site, with no API, can render sample data. */
export function CountryBreakdown({
  code,
  query,
  totalRequests,
  onClose,
}: {
  code: string;
  query: string;
  /** So the header can say what share of it this country is. */
  totalRequests: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<CountryBreakdownData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    fetch(`/api/analytics/country${query}&code=${encodeURIComponent(code)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: CountryBreakdownData) => {
        if (!cancelled) setData(body);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, query]);

  return (
    <CountryBreakdownView
      code={code}
      data={data}
      error={error}
      totalRequests={totalRequests}
      onClose={onClose}
    />
  );
}

export function CountryBreakdownView({
  code,
  data,
  error = false,
  totalRequests,
  onClose,
}: {
  code: string;
  /** Null while loading. */
  data: CountryBreakdownData | null;
  error?: boolean;
  totalRequests: number;
  onClose: () => void;
}) {
  const t = useTranslations("analytics");
  const locale = useLocale();
  const format = useFormatter();

  // The UI's locale, not the browser's, so it matches the map popup and server and client agree.
  // "XX" is traffic GeoIP could not place, which no locale names.
  const name = code === "XX" ? t("unplacedCountry") : regionName(code, locale);
  const share = totalRequests > 0 && data ? ((data.total / totalRequests) * 100).toFixed(1) : null;

  return (
    <Card padding={5} data-testid="country-breakdown">
      <VStack gap={4}>
        <HStack gap={3} vAlign="center" justify="between">
          <HStack gap={3} vAlign="center" wrap="wrap">
            <Text as="h2" type="body" weight="semibold">
              {name}
            </Text>
            {data && (
              <Text type="supporting" color="secondary">
                {t("breakdownSummary", {
                  requests: format.number(data.total),
                  share: share ?? "0",
                  uniqueIps: format.number(data.uniqueIps),
                  blocked: format.number(data.blocked),
                })}
              </Text>
            )}
          </HStack>
          <IconButton
            variant="ghost"
            size="sm"
            icon={<X />}
            label={t("closeBreakdown")}
            tooltip={t("closeBreakdown")}
            onClick={onClose}
          />
        </HStack>

        {error ? (
          <EmptyState title={t("breakdownLoadError")} isCompact />
        ) : !data ? (
          <HStack justify="center" vAlign="center" height={120}>
            <Spinner label={t("loadingBreakdown")} />
          </HStack>
        ) : data.total === 0 ? (
          <EmptyState title={t("noTrafficRecorded")} isCompact />
        ) : (
          <Grid columns={{ minWidth: 220, max: 3 }} gap={6}>
            <RankedList
              title={t("breakdownHosts")}
              rows={data.hosts.map((h) => ({ label: h.host, count: h.count }))}
              color="var(--color-data-blue-3)"
            />
            <RankedList
              title={t("breakdownResponses")}
              rows={[
                { label: "2xx", count: data.statusClasses.ok },
                { label: "3xx", count: data.statusClasses.redirects },
                { label: "4xx", count: data.statusClasses.clientErrors },
                { label: "5xx", count: data.statusClasses.serverErrors },
              ]}
              color="var(--color-data-categorical-teal)"
            />
            <RankedList
              title={t("topUserAgents")}
              rows={data.userAgents.map((u) => ({ label: u.userAgent, count: u.count }))}
              color="var(--color-border-emphasized)"
            />
          </Grid>
        )}
      </VStack>
    </Card>
  );
}
