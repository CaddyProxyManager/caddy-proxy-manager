"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { UrlPowerSearch } from "@/components/ui/UrlPowerSearch";
import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { StatTiles } from "@/components/ui/StatTiles";
import { ActivityStrip, type ActivityBucket } from "@/components/ui/ActivityStrip";
import { Timestamp } from "@/components/ui/Timestamp";
import { useTranslations } from "next-intl";

type EventRow = {
  id: number;
  createdAt: string;
  user: string;
  action: string;
  entityType: string;
  summary: string;
};

type Props = {
  events: EventRow[];
  pagination: { total: number; page: number; perPage: number };
  /** Resources and actions are stored identifiers, shown as they are. */
  filterOptions: {
    users: { value: string; label: string }[];
    resources: string[];
    actions: string[];
  };
  /** 24 hourly buckets covering the last day of the whole log, search or no search. */
  activity: ActivityBucket[];
  summary: { events: number; actors: number; entityTypes: number };
};

export default function AuditLogClient({
  events,
  pagination,
  filterOptions,
  activity,
  summary,
}: Props) {
  const t = useTranslations("auditLog");
  const columns: Column<EventRow>[] = [
    {
      id: "created_at",
      label: t("time"),
      width: 180,
      render: (r) => (
        <Text type="body" size="sm" color="secondary">
          <Timestamp value={r.createdAt} />
        </Text>
      ),
    },
    {
      id: "user",
      label: t("user"),
      width: 160,
      render: (r) => <Badge label={r.user} />,
    },
    {
      id: "resource",
      label: t("resource"),
      width: 200,
      render: (r) => (
        <VStack gap={0} className="cpm-cell-lines">
          <Text type="body" size="sm">
            {r.entityType}
          </Text>
          <Text type="code" size="xsm" color="secondary">
            {r.action}
          </Text>
        </VStack>
      ),
    },
    {
      id: "summary",
      label: t("event"),
      render: (r) => (
        <Text type="body" size="sm">
          {r.summary}
        </Text>
      ),
    },
  ];

  const mobileCard = (r: EventRow) => (
    <Card>
      <VStack gap={1}>
        <HStack justify="between" vAlign="center" gap={2}>
          <Badge label={r.user} />
          <Text type="body" size="xsm" color="secondary">
            <Timestamp value={r.createdAt} />
          </Text>
        </HStack>
        <Text type="body" size="sm">
          {r.summary}
        </Text>
      </VStack>
    </Card>
  );

  return (
    <VStack gap={6}>
      <ListPageHeader
        title={t("auditLog")}
        stats={
          <StatTiles
            tiles={[
              {
                id: "day",
                label: t("eventsLastDay"),
                value: summary.events,
                note: t("actorsNote", { count: summary.actors }),
              },
              {
                id: "kinds",
                label: t("resourceKinds"),
                value: summary.entityTypes,
                note: t("resourceKindsNote"),
              },
              {
                id: "total",
                label: t("eventsRecorded"),
                value: pagination.total,
                note: t("matchingNote"),
              },
            ]}
          />
        }
        summary={
          <Card padding={4}>
            <ActivityStrip
              buckets={activity}
              title={t("activityTitle")}
              describePeak={(bucket) =>
                t("activityPeak", { label: bucket.label, count: bucket.count })
              }
            />
          </Card>
        }
        search={
          <UrlPowerSearch
            name="AuditLog"
            label={t("searchLabel")}
            placeholder={t("searchAuditLog")}
            resultCount={pagination.total}
            fields={[
              { param: "search", label: t("event"), kind: "text" },
              { param: "user", label: t("user"), kind: "enum", values: filterOptions.users },
              {
                param: "resource",
                label: t("resource"),
                kind: "enum",
                values: filterOptions.resources.map((value) => ({ value, label: value })),
              },
              {
                param: "action",
                label: t("action"),
                kind: "enum",
                values: filterOptions.actions.map((value) => ({ value, label: value })),
              },
            ]}
          />
        }
      />

      <DataTable
        columns={columns}
        data={events}
        keyField="id"
        emptyMessage={t("noAuditEventsFound")}
        pagination={pagination}
        mobileCard={mobileCard}
      />
    </VStack>
  );
}
