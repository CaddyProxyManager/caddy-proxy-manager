"use client";

import { useEffect, useState, useTransition } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { ShieldCheck } from "lucide-react";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { UrlPowerSearch } from "@/components/ui/UrlPowerSearch";
import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { StatTiles } from "@/components/ui/StatTiles";
import { ActivityStrip, type ActivityBucket } from "@/components/ui/ActivityStrip";
import { Timestamp } from "@/components/ui/Timestamp";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { AuditChanges, type DiffLayout } from "@/components/audit/AuditChanges";
import type { AuditChange } from "@/lib/audit/changes";
import type { AuditChainVerification } from "@/lib/audit/chain";
import type { AuditRevisionLink } from "@/lib/host-history/types";

type EventRow = {
  id: number;
  createdAt: string;
  user: string;
  action: string;
  entityType: string;
  summary: string;
  /** Field-level before and after, when the event recorded them. */
  changes?: AuditChange[] | null;
  /** A host event's way back: its history, ready to roll back or restore. */
  revisionLink?: AuditRevisionLink | null;
};

export type VerifyChainResult =
  | { ok: true; verification: AuditChainVerification }
  | { ok: false; message: string };

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
  /** The server action, passed in so this component stays free of server imports. */
  verifyChain?: () => Promise<VerifyChainResult>;
};

const LAYOUT_KEY = "cpm-audit-diff-layout";

/** Per browser: a reader's preference, not the log's state. */
function useDiffLayout(): [DiffLayout, (layout: DiffLayout) => void] {
  const [layout, setLayout] = useState<DiffLayout>("unified");
  useEffect(() => {
    try {
      if (localStorage.getItem(LAYOUT_KEY) === "split") setLayout("split");
    } catch {
      // Storage blocked: the default stands.
    }
  }, []);
  return [
    layout,
    (next) => {
      setLayout(next);
      try {
        localStorage.setItem(LAYOUT_KEY, next);
      } catch {
        // As above.
      }
    },
  ];
}

function ChainResult({ result }: { result: VerifyChainResult }) {
  const t = useTranslations("auditLog");
  if (!result.ok)
    return <Banner status="error" title={t("verifyFailed")} description={result.message} />;
  const { verification } = result;
  const legacy =
    verification.legacy > 0 ? t("chainLegacy", { count: verification.legacy }) : undefined;
  if (verification.ok) {
    return (
      <Banner
        status="success"
        title={t("chainIntact")}
        description={[t("chainIntactDetail", { count: verification.checked }), legacy]
          .filter(Boolean)
          .join(" ")}
      />
    );
  }
  const broken = verification.firstBroken;
  return (
    <Banner
      status="error"
      title={t("chainBroken")}
      description={
        broken
          ? t(`chainBreaks.${broken.reason}`, {
              seq: String(broken.seq ?? ""),
              eventId: String(broken.eventId ?? ""),
            })
          : undefined
      }
    />
  );
}

export default function AuditLogClient({
  events,
  pagination,
  filterOptions,
  activity,
  summary,
  verifyChain,
}: Props) {
  const t = useTranslations("auditLog");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState<EventRow | null>(null);
  const [layout, setLayout] = useDiffLayout();
  const [verification, setVerification] = useState<VerifyChainResult | null>(null);
  const [verifying, startVerify] = useTransition();
  const verify = () =>
    startVerify(async () => {
      if (!verifyChain) return;
      setVerification(await verifyChain());
    });
  const columns: Column<EventRow>[] = [
    {
      id: "created_at",
      label: tCommon("time"),
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
          <Text type="code" size="sm" color="secondary">
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
    {
      id: "changes",
      label: t("changes"),
      width: 140,
      render: (r) => (
        <VStack gap={1}>
          {r.changes && r.changes.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              label={tCommon("changeCount", { count: r.changes.length })}
              onClick={() => setOpen(r)}
            />
          )}
          <RevisionLinkButton link={r.revisionLink} />
        </VStack>
      ),
    },
  ];

  const mobileCard = (r: EventRow) => (
    <Card>
      <VStack gap={1}>
        <HStack justify="between" vAlign="center" gap={2}>
          <Badge label={r.user} />
          <Text type="body" size="sm" color="secondary">
            <Timestamp value={r.createdAt} />
          </Text>
        </HStack>
        <Text type="body" size="sm">
          {r.summary}
        </Text>
        {r.changes && r.changes.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            label={tCommon("changeCount", { count: r.changes.length })}
            onClick={() => setOpen(r)}
          />
        )}
        <RevisionLinkButton link={r.revisionLink} />
      </VStack>
    </Card>
  );

  return (
    <VStack gap={6}>
      <ListPageHeader
        title={tNav("auditLog")}
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

      {verifyChain && (
        <VStack gap={3}>
          <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
            <Text type="body" size="sm" color="secondary">
              {t("verifyChainHelp")}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              icon={<ShieldCheck />}
              label={tCommon("verify")}
              onClick={verify}
              isLoading={verifying}
            />
          </HStack>
          {verification && <ChainResult result={verification} />}
        </VStack>
      )}

      <DataTable
        columns={columns}
        data={events}
        keyField="id"
        emptyMessage={t("noAuditEventsFound")}
        pagination={pagination}
        mobileCard={mobileCard}
      />

      <AppDialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open?.summary ?? ""}
        maxWidth="xl"
      >
        <VStack gap={3}>
          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
            <Text type="body" size="sm" color="secondary">
              {open?.changes?.some((change) => change.masked) ? t("maskedNote") : t("changesNote")}
            </Text>
            <SegmentedControl
              label={t("diffView")}
              size="sm"
              value={layout}
              onChange={(value) => setLayout(value as DiffLayout)}
            >
              <SegmentedControlItem value="unified" label={t("diffUnified")} />
              <SegmentedControlItem value="split" label={t("diffSideBySide")} />
            </SegmentedControl>
          </HStack>
          {open?.changes && <AuditChanges changes={open.changes} layout={layout} />}
        </VStack>
      </AppDialog>
    </VStack>
  );
}

/** One word in the cell; the tooltip says which way back it goes. */
function RevisionLinkButton({ link }: { link?: AuditRevisionLink | null }) {
  const t = useTranslations("hostHistory");
  const tCommon = useTranslations("common");
  if (!link) return null;
  return link.kind === "restore" ? (
    <Button
      variant="ghost"
      size="sm"
      label={tCommon("restore")}
      tooltip={t("auditRestore")}
      href={link.href}
    />
  ) : (
    <Button
      variant="ghost"
      size="sm"
      label={t("revert")}
      tooltip={t("auditRollback")}
      href={link.href}
      data-testid="audit-rollback"
    />
  );
}
