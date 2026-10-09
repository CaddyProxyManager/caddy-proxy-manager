"use client";

/**
 * One ranked list: hosts, paths, countries and so on. Each row can narrow the page to itself or
 * leave itself out; "View all" asks for up to 100 rows. Presentational.
 */

import { useCallback } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { Download, ListFilter, ListX } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import type { TrafficOutcome } from "@cpm/shared";
import { regionName } from "@/src/lib/locale/region-names";
import type { FilterOp, TopDimension } from "@/src/lib/analytics/explore-state";
import type { TopRow } from "@/src/lib/clickhouse/explore";
import { useTableDensity } from "@/components/ui/TableDensity";
import { FlagIcon } from "@/components/ui/CountryFlag";
import { csvFileName, downloadCsv, toCsv } from "./csv";
import { formatShare, OUTCOME_KEY, TOP_TITLE_KEY } from "./format";

type Row = TopRow & { [k: string]: unknown };

type Translate = ReturnType<typeof useTranslations<"analytics">>;

/** How a row's key reads: a country's name, an AS number with its network, and so on. */
export function topRowLabel(
  t: Translate,
  locale: string,
  dimension: TopDimension,
  row: Pick<TopRow, "key" | "label">,
): string {
  switch (dimension) {
    case "country":
      return row.key === "XX" ? t("unplacedCountry") : regionName(row.key, locale);
    case "asn":
      return row.label ? `AS${row.key} ${row.label}` : `AS${row.key}`;
    case "rule":
      return row.label ? `#${row.key} ${row.label}` : `#${row.key}`;
    default:
      return row.key || t("unknownValue");
  }
}

export function useTopRowLabel(dimension: TopDimension) {
  const t = useTranslations("analytics");
  const locale = useLocale();
  return useCallback(
    (row: Pick<TopRow, "key" | "label">) => topRowLabel(t, locale, dimension, row),
    [t, locale, dimension],
  );
}

export function topListCsv(
  t: Translate,
  dimension: TopDimension,
  rows: readonly TopRow[],
  label: (row: TopRow) => string,
): void {
  const header = [
    t("csv.key"),
    t("csv.label"),
    t("csv.requests"),
    t("csv.mitigated"),
    t("csv.serverErrors"),
    t("csv.bytes"),
  ];
  const body = rows.map((row) => [
    row.key,
    label(row),
    row.requests,
    row.mitigated,
    row.serverErrors,
    row.bytes,
  ]);
  downloadCsv(csvFileName("analytics", dimension), toCsv(header, body));
}

export function TopListTable({
  dimension,
  rows,
  total,
  onFilter,
}: {
  dimension: TopDimension;
  rows: readonly TopRow[];
  /** The page's request total, for each row's share. */
  total: number;
  onFilter?: (dimension: TopDimension, value: string, op: FilterOp) => void;
}) {
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");
  const format = useAppFormatter();
  const density = useTableDensity();
  const label = useTopRowLabel(dimension);
  // A WAF rule counts WAF events, which are not a share of requests.
  const shareOf = dimension === "rule" ? rows.reduce((sum, r) => sum + r.requests, 0) : total;

  const columns: TableColumn<Row>[] = [
    {
      key: "key",
      header: t(`topColumn.${TOP_TITLE_KEY[dimension]}`),
      // A full eight-group IPv6 address; a narrower card scrolls rather than cutting it.
      width: proportional(1, { minWidth: dimension === "ip" ? 340 : 0 }),
      renderCell: (row) => {
        const text = (
          <Tooltip content={label(row)}>
            <Text
              type={dimension === "path" || dimension === "ip" ? "code" : "body"}
              size="sm"
              maxLines={1}
            >
              {label(row)}
            </Text>
          </Tooltip>
        );
        if (dimension !== "country") return text;
        return (
          <HStack gap={2} vAlign="center">
            <FlagIcon code={row.key} />
            {text}
          </HStack>
        );
      },
    },
    {
      key: "requests",
      header: dimension === "rule" ? t("hits") : tCommon("requests"),
      align: "end",
      width: pixel(80),
      renderCell: (row) => (
        <Text type="body" size="sm" hasTabularNumbers>
          {format.number(row.requests)}
        </Text>
      ),
    },
    {
      key: "share",
      header: t("share"),
      align: "end",
      width: pixel(64),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary" hasTabularNumbers>
          {formatShare(format, row.requests, shareOf)}
        </Text>
      ),
    },
  ];
  if (onFilter) {
    columns.push({
      key: "actions",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      align: "end",
      width: pixel(72),
      renderCell: (row) => (
        <HStack gap={1} justify="end">
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            icon={<ListFilter />}
            label={t("filterTo", { value: label(row) })}
            tooltip={t("filterToShort")}
            onClick={() => onFilter(dimension, row.key, "is")}
          />
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            icon={<ListX />}
            label={t("filterOut", { value: label(row) })}
            tooltip={t("filterOutShort")}
            onClick={() => onFilter(dimension, row.key, "not")}
          />
        </HStack>
      ),
    });
  }

  return (
    <Table
      density={density}
      data={rows.map((row) => ({ ...row }))}
      columns={columns}
      idKey="key"
      hasHover
    />
  );
}

export function TopListCard({
  dimension,
  rows,
  total,
  onFilter,
  onViewAll,
  onExport,
}: {
  dimension: TopDimension;
  rows: readonly TopRow[];
  total: number;
  onFilter?: (dimension: TopDimension, value: string, op: FilterOp) => void;
  onViewAll?: (dimension: TopDimension) => void;
  /** Exports the view-all rows rather than these ten, when the page can fetch them. */
  onExport?: (dimension: TopDimension) => void;
}) {
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");
  const label = useTopRowLabel(dimension);
  const title = t(`top.${TOP_TITLE_KEY[dimension]}`);
  return (
    <Card padding={4} data-testid={`analytics-top-${dimension}`}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2}>
          <Text as="h2" type="body" size="sm" weight="semibold">
            {title}
          </Text>
          <HStack gap={1} vAlign="center">
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<Download />}
              label={t("csv.exportList", { list: title })}
              tooltip={t("csv.exportListShort")}
              isDisabled={rows.length === 0}
              onClick={() =>
                onExport ? onExport(dimension) : topListCsv(t, dimension, rows, label)
              }
            />
            {onViewAll && (
              <Button
                variant="ghost"
                size="sm"
                label={t("viewAll")}
                isDisabled={rows.length === 0}
                onClick={() => onViewAll(dimension)}
              />
            )}
          </HStack>
        </HStack>
        {rows.length === 0 ? (
          <EmptyState title={tCommon("noData")} isCompact />
        ) : (
          <TopListTable dimension={dimension} rows={rows} total={total} onFilter={onFilter} />
        )}
      </VStack>
    </Card>
  );
}

/** The outcome a filter or the log shows, from the catalog. */
export function useOutcomeLabel() {
  const t = useTranslations("analytics");
  return useCallback(
    (outcome: TrafficOutcome) => t(`outcomes.${OUTCOME_KEY[outcome] ?? "served"}`),
    [t],
  );
}
