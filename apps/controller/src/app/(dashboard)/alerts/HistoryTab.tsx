"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useTableDensity } from "@/components/ui/TableDensity";
import { Timestamp } from "@/components/ui/Timestamp";
import { unwrap } from "@/src/lib/errors/action-result";
import { type AlertsOverview, type HistoryRow, loadHistoryAction } from "./actions";
import { message, SEVERITIES, SeverityToken, useChannelName, useRuleName } from "./shared";

const TYPES = ["notice", "problem", "recovery"] as const;
const STATUSES = ["pending", "sent", "failed", "dropped", "withdrawn"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_COLOR = {
  pending: "blue",
  sent: "green",
  failed: "red",
  dropped: "gray",
  withdrawn: "gray",
} as const;

const ANY = "any";

type Filters = { rule: string; channel: string; severity: string; type: string; status: string };

const NO_FILTERS: Filters = { rule: ANY, channel: ANY, severity: ANY, type: ANY, status: ANY };

function filterOf(filters: Filters, before: number | null) {
  const pick = (value: string) => (value === ANY ? null : value);
  return {
    ruleId: filters.rule === ANY ? null : Number(filters.rule),
    channelId: filters.channel === ANY ? null : Number(filters.channel),
    severity: pick(filters.severity),
    type: pick(filters.type),
    status: pick(filters.status),
    before,
  };
}

function Deliveries({ row }: { row: HistoryRow }) {
  const t = useTranslations("alerts.history");
  const channelName = useChannelName();
  if (row.deliveries.length === 0) {
    return (
      <Text type="body" size="sm" color="secondary">
        {t("noDeliveries")}
      </Text>
    );
  }
  return (
    <VStack gap={1}>
      <HStack gap={1} wrap="wrap">
        {row.deliveries.map((delivery) => {
          const status = (delivery.status in STATUS_COLOR ? delivery.status : "pending") as Status;
          const name = channelName({
            name: delivery.channelName,
            builtin:
              delivery.channelKind === "email" || delivery.channelKind === "push"
                ? delivery.channelKind
                : null,
          });
          return (
            <Token
              key={delivery.id}
              size="sm"
              color={STATUS_COLOR[status]}
              label={t("delivery", { channel: name, status: t(`statuses.${status}`) })}
            />
          );
        })}
      </HStack>
      {row.deliveries
        .filter((delivery) => delivery.lastError)
        .map((delivery) => (
          <Text key={delivery.id} type="body" size="sm" color="secondary" maxLines={2}>
            {delivery.lastError}
          </Text>
        ))}
    </VStack>
  );
}

export function HistoryTab({ overview }: { overview: AlertsOverview }) {
  const t = useTranslations("alerts.history");
  const tRules = useTranslations("alerts.rules");
  const tCommon = useTranslations("common");
  const tSeverity = useTranslations("attention.severity");
  const density = useTableDensity();
  const ruleName = useRuleName();
  const channelName = useChannelName();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before: number | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = unwrap(await loadHistoryAction(filterOf(filters, before)));
        setRows((prev) => (before === null ? page.rows : [...prev, ...page.rows]));
        setHasMore(page.hasMore);
      } catch (err) {
        setError(message(err, t("loadFailed")));
      } finally {
        setLoading(false);
      }
    },
    [filters, t],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const set = (key: keyof Filters) => (value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  const any = { value: ANY, label: t("any") };

  type Row = HistoryRow & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "at",
      header: tCommon("time"),
      width: pixel(170),
      renderCell: (row) => <Timestamp value={row.at} style="dateTimeShort" />,
    },
    {
      key: "title",
      header: t("alert"),
      width: proportional(2),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold" maxLines={2}>
            {row.title}
          </Text>
          <Text type="body" size="sm" color="secondary" maxLines={3}>
            {row.text}
          </Text>
        </VStack>
      ),
    },
    {
      key: "rule",
      header: t("rule"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={1}>
          <Text type="body" size="sm" maxLines={1}>
            {ruleName({ name: row.ruleName, settingKey: row.ruleSettingKey })}
          </Text>
          <HStack gap={1}>
            <SeverityToken severity={row.severity} />
            <Token
              size="sm"
              color="gray"
              label={t(
                `types.${(TYPES as readonly string[]).includes(row.type) ? (row.type as (typeof TYPES)[number]) : "notice"}`,
              )}
            />
          </HStack>
        </VStack>
      ),
    },
    {
      key: "deliveries",
      header: t("deliveries"),
      width: proportional(2),
      renderCell: (row) => <Deliveries row={row} />,
    },
  ];

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={2}>{t("title")}</Heading>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw />}
            label={t("refresh")}
            isLoading={loading}
            onClick={() => void load(null)}
          />
        </HStack>
        <Text type="body" size="sm" color="secondary">
          {t("help")}
        </Text>
        <Grid columns={{ minWidth: 160, max: 5 }} gap={2}>
          <Selector
            label={t("rule")}
            size="sm"
            options={[
              any,
              ...overview.rules.map((rule) => ({ value: String(rule.id), label: ruleName(rule) })),
            ]}
            value={filters.rule}
            onChange={set("rule")}
          />
          <Selector
            label={t("channel")}
            size="sm"
            options={[
              any,
              ...overview.channels.map((channel) => ({
                value: String(channel.id),
                label: channelName(channel),
              })),
            ]}
            value={filters.channel}
            onChange={set("channel")}
          />
          <Selector
            label={tRules("severity")}
            size="sm"
            options={[
              any,
              ...SEVERITIES.map((severity) => ({ value: severity, label: tSeverity(severity) })),
            ]}
            value={filters.severity}
            onChange={set("severity")}
          />
          <Selector
            label={t("type")}
            size="sm"
            options={[any, ...TYPES.map((type) => ({ value: type, label: t(`types.${type}`) }))]}
            value={filters.type}
            onChange={set("type")}
          />
          <Selector
            label={tCommon("status")}
            size="sm"
            options={[
              any,
              ...STATUSES.map((status) => ({ value: status, label: t(`statuses.${status}`) })),
            ]}
            value={filters.status}
            onChange={set("status")}
          />
        </Grid>
        {error && <Banner status="error" title={t("loadFailed")} description={error} />}
        {rows.length === 0 && !loading ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} isCompact />
        ) : (
          <Table
            density={density}
            data={rows.map((row) => ({ ...row }))}
            columns={columns}
            idKey="id"
          />
        )}
        {hasMore && (
          <HStack justify="center">
            <Button
              size="sm"
              variant="secondary"
              label={t("older")}
              isLoading={loading}
              onClick={() => void load(rows.at(-1)?.id ?? null)}
            />
          </HStack>
        )}
      </VStack>
    </Card>
  );
}
