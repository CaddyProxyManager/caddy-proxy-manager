"use client";

/** The latest requests under the page's filters, optionally only those a gate stopped. */

import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { CountryFlag } from "@/components/ui/CountryFlag";
import { Timestamp } from "@/components/ui/Timestamp";
import { useEmptyValue } from "@/components/ui/empty-value";
import { useTableDensity } from "@/components/ui/TableDensity";
import type { ExploreRequest } from "@/src/lib/clickhouse/explore";
import { formatBytes, OUTCOME_HUE } from "./format";
import { useOutcomeLabel } from "./TopList";

type Row = ExploreRequest & { id: string; [k: string]: unknown };

export function RequestLog({
  requests,
  mitigatedOnly,
  onMitigatedOnlyChange,
}: {
  requests: readonly ExploreRequest[];
  mitigatedOnly: boolean;
  onMitigatedOnlyChange: (value: boolean) => void;
}) {
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");
  const format = useAppFormatter();
  const density = useTableDensity();
  const emptyValue = useEmptyValue();
  const outcomeLabel = useOutcomeLabel();

  // Several requests can share a second, client and URI; the position keeps keys unique.
  const rows: Row[] = requests.map((request, index) => ({
    ...request,
    id: `${request.ts}-${index}`,
  }));

  const columns: TableColumn<Row>[] = [
    {
      key: "ts",
      header: tCommon("time"),
      width: pixel(200),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          <Timestamp value={row.ts * 1000} />
        </Text>
      ),
    },
    {
      key: "clientIp",
      header: tCommon("client"),
      // A full eight-group IPv6 address beside its flag.
      width: pixel(380),
      renderCell: (row) => (
        <HStack gap={1} vAlign="center">
          {row.countryCode && <CountryFlag code={row.countryCode} />}
          <Tooltip content={row.asn ? `AS${row.asn} ${row.asnOrg ?? ""}`.trim() : row.clientIp}>
            <Text type="code" size="sm" maxLines={1}>
              {row.clientIp}
            </Text>
          </Tooltip>
        </HStack>
      ),
    },
    {
      key: "host",
      header: t("host"),
      width: pixel(170),
      renderCell: (row) => (
        <Text type="body" size="sm" maxLines={1}>
          {row.host || emptyValue}
        </Text>
      ),
    },
    {
      key: "uri",
      header: tCommon("request"),
      width: proportional(1),
      renderCell: (row) => (
        <Tooltip content={`${row.method} ${row.uri}`}>
          <Text type="code" size="sm" maxLines={1}>
            {row.method} {row.uri}
          </Text>
        </Tooltip>
      ),
    },
    {
      key: "status",
      header: t("status"),
      width: pixel(72),
      align: "end",
      renderCell: (row) => (
        <Text type="code" size="sm" hasTabularNumbers>
          {row.status}
        </Text>
      ),
    },
    {
      key: "outcome",
      header: t("outcome"),
      width: pixel(130),
      renderCell: (row) => (
        <Token
          size="sm"
          label={outcomeLabel(row.outcome)}
          color={OUTCOME_HUE[row.outcome] ?? "gray"}
        />
      ),
    },
    {
      key: "durationMs",
      header: t("duration"),
      width: pixel(90),
      align: "end",
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary" hasTabularNumbers>
          {row.durationMs === null
            ? emptyValue
            : t("milliseconds", { ms: format.number(row.durationMs) })}
        </Text>
      ),
    },
    {
      key: "bytesSent",
      header: t("size"),
      width: pixel(90),
      align: "end",
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary" hasTabularNumbers>
          {formatBytes(format, row.bytesSent)}
        </Text>
      ),
    },
  ];

  return (
    <Card padding={5}>
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
          <Text as="h2" type="body" size="sm" weight="semibold">
            {t("latestRequests")}
          </Text>
          <Switch
            size="sm"
            label={t("mitigatedOnly")}
            value={mitigatedOnly}
            onChange={onMitigatedOnlyChange}
          />
        </HStack>
        {rows.length === 0 ? (
          <EmptyState
            title={mitigatedOnly ? t("mitigatedEmptyTitle") : t("requestsEmptyTitle")}
            isCompact
          />
        ) : (
          <>
            <div className="cpm-desktop-only">
              <Table density={density} data={rows} columns={columns} idKey="id" hasHover />
            </div>
            <div className="cpm-mobile-only">
              <List>
                {rows.map((row) => (
                  <ListItem
                    key={row.id}
                    label={`${row.method} ${row.uri}`}
                    description={`${row.host} - ${row.clientIp} - ${row.status}`}
                    endContent={
                      <Token
                        size="sm"
                        label={outcomeLabel(row.outcome)}
                        color={OUTCOME_HUE[row.outcome] ?? "gray"}
                      />
                    }
                  />
                ))}
              </List>
            </div>
          </>
        )}
      </VStack>
    </Card>
  );
}
