"use client";

/**
 * A host's revisions and the comparison of any two. Presentational: the route reads everything,
 * hands the restore action in, and keeps the selection in the query string so a comparison - and
 * the audit log's rollback link - is a shareable URL.
 */

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { Timestamp } from "@/components/ui/Timestamp";
import { AuditChanges } from "@/components/audit/AuditChanges";
import { DiffView } from "@/src/app/(dashboard)/settings/StagedChanges";
import type { ActionState } from "@/lib/errors/action-error";
import type { AuditChange } from "@/lib/audit/changes";
import type { ConfigDiff } from "@/lib/settings/config-diff";
import type { HostRevisionSummary, MissingReference } from "@/lib/host-history/types";

export type HostHistoryComparison = {
  from: number;
  to: number;
  changes: AuditChange[];
  config?: ConfigDiff | null;
};

type Props = {
  /** False once the host is deleted: restore replaces rollback. */
  live: boolean;
  revisions: HostRevisionSummary[];
  page: number;
  perPage: number;
  total: number;
  ids: number[];
  latest: number;
  selection: { from: number; to: number } | null;
  comparison: HostHistoryComparison | null;
  showConfig: boolean;
  /** The editor's URL, short of the revision id to load; null where the reader cannot manage it. */
  rollbackHref: string | null;
  /** What restoring `to` would leave out; null unless the host is deleted and may be restored. */
  restore: {
    missing: MissingReference[];
    name: string;
    action: (revisionId: number, dropMissing: boolean) => Promise<ActionState>;
  } | null;
};

type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

export function HostHistoryView(props: Props) {
  const t = useTranslations("hostHistory");
  const tSettings = useTranslations("settings");
  const { revisions, selection, latest, live } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const navigate = (changes: Record<string, number | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) next.delete(name);
      else next.set(name, String(value));
    }
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <VStack gap={5}>
      <Text type="supporting" color="secondary">
        {t("subtitle")}
      </Text>
      {!live && (
        <Banner status="warning" title={t("deletedTitle")} description={t("deletedDescription")} />
      )}

      <Card padding={0}>
        <VStack gap={0} data-testid="host-revision-list">
          <HStack gap={2} vAlign="center" padding={4}>
            <Heading level={3} accessibilityLevel={2}>
              {tSettings("history.listTitle")}
            </Heading>
          </HStack>
          {revisions.map((revision) => (
            <RevisionRow
              key={revision.id}
              revision={revision}
              isCurrent={live && revision.id === latest}
              isSelected={selection?.to === revision.id}
              onView={() => navigate({ to: revision.id, from: null })}
            />
          ))}
          {props.total > props.perPage && (
            <HStack justify="center" padding={3}>
              <Pagination
                page={props.page}
                pageSize={props.perPage}
                totalItems={props.total}
                onChange={(page: number) => navigate({ page })}
              />
            </HStack>
          )}
        </VStack>
      </Card>

      {selection && (
        <ComparisonCard
          ids={props.ids}
          selection={selection}
          comparison={props.comparison}
          latest={latest}
          live={live}
          showConfig={props.showConfig}
          rollbackHref={props.rollbackHref}
          restore={props.restore}
          onSelect={navigate}
        />
      )}
    </VStack>
  );
}

export function useOperationLabel() {
  const t = useTranslations("hostHistory");
  const dynamic = t as unknown as DynamicTranslate;
  return (revision: Pick<HostRevisionSummary, "operation" | "detail">) => {
    const detail = revision.detail ?? {};
    if (revision.operation === "bulk") {
      const action = detail.action ?? "";
      const known = t.has(`bulkActions.${action}` as Parameters<typeof t.has>[0]);
      return t("operations.bulk", {
        action: known ? dynamic(`bulkActions.${action}`, { tag: detail.tag ?? "" }) : action,
      });
    }
    return dynamic(`operations.${revision.operation}`, { revision: detail.revision ?? 0 });
  };
}

function RevisionRow({
  revision,
  isCurrent,
  isSelected,
  onView,
}: {
  revision: HostRevisionSummary;
  isCurrent: boolean;
  isSelected: boolean;
  onView: () => void;
}) {
  const t = useTranslations("hostHistory");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const label = useOperationLabel();
  return (
    <>
      <Divider />
      <HStack
        gap={3}
        vAlign="center"
        paddingBlock={3}
        paddingInline={4}
        className={isSelected ? "bg-muted" : undefined}
        data-testid={`host-revision-${revision.id}`}
      >
        <Text type="code" size="sm" color="secondary">
          #{revision.id}
        </Text>
        <VStack gap={0} className="min-w-0 grow">
          <Text type="label" maxLines={1}>
            {label(revision)}
          </Text>
          <Text type="supporting" color="secondary">
            {tSettings("history.appliedBy", {
              name: revision.userName ?? tSettings("history.unknownUser"),
            })}{" "}
            · <Timestamp value={revision.createdAt} style="dateTimeShort" />
          </Text>
        </VStack>
        {isCurrent && <Badge variant="success" label={tSettings("history.current")} />}
        {revision.operation === "delete" && <Badge variant="error" label={t("deletedBadge")} />}
        <Button
          variant="ghost"
          size="sm"
          label={tCommon("view")}
          onClick={onView}
          isDisabled={isSelected}
        />
      </HStack>
    </>
  );
}

function ComparisonCard({
  ids,
  selection,
  comparison,
  latest,
  live,
  showConfig,
  rollbackHref,
  restore,
  onSelect,
}: {
  ids: number[];
  selection: { from: number; to: number };
  comparison: HostHistoryComparison | null;
  latest: number;
  live: boolean;
  showConfig: boolean;
  rollbackHref: Props["rollbackHref"];
  restore: Props["restore"];
  onSelect: (changes: Record<string, number | null>) => void;
}) {
  const t = useTranslations("hostHistory");
  const tSettings = useTranslations("settings");
  const { from, to } = selection;
  const optionIds = [...new Set([...ids, from, to])].filter((id) => id > 0).sort((a, b) => b - a);
  const options = optionIds.map((id) => ({
    value: String(id),
    label: tSettings("history.revisionOption", { id }),
  }));
  const fromOptions = [...options, { value: "0", label: t("initial") }];
  const target = comparison && comparison.to === to ? to : null;
  const canRollBack = live && rollbackHref !== null && target !== null && to !== latest;

  return (
    <Card padding={4}>
      <VStack gap={4} data-testid="host-revision-comparison">
        <HStack gap={3} vAlign="end" wrap="wrap">
          <Heading level={3} accessibilityLevel={2}>
            {tSettings("history.compareTitle")}
          </Heading>
          <StackItem size="fill" />
          <Selector
            label={tSettings("history.compareFrom")}
            size="sm"
            options={fromOptions}
            value={String(from)}
            onChange={(value) => onSelect({ from: Number(value) })}
          />
          <Selector
            label={tSettings("history.compareTo")}
            size="sm"
            options={options}
            value={String(to)}
            onChange={(value) => onSelect({ to: Number(value) })}
          />
        </HStack>

        {from === to ? (
          <Banner status="info" title={tSettings("history.same")} />
        ) : (
          <Text type="supporting" color="secondary">
            {from === 0
              ? t("comparisonSubtitleInitial", { to })
              : tSettings("history.comparisonSubtitle", { from, to })}
          </Text>
        )}

        {canRollBack && rollbackHref && (
          <HStack gap={3} vAlign="center">
            <Text type="supporting" color="secondary" className="grow">
              {t("rollbackHelp", { id: to })}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("revert")}
              href={`${rollbackHref}${to}`}
              data-testid="rollback-revision"
            />
          </HStack>
        )}
        {live && to === latest && (
          <Text type="supporting" color="secondary">
            {t("rollbackLatest")}
          </Text>
        )}
        {!live && restore && <RestoreRow revisionId={to} restore={restore} />}

        {comparison && comparison.from === from && comparison.to === to && (
          <ComparisonBody comparison={comparison} />
        )}

        <Divider />
        <Switch
          label={t("showConfig")}
          description={t("showConfigHelp")}
          value={showConfig}
          onChange={(next) => onSelect({ config: next ? 1 : null })}
        />
        {showConfig && comparison && <ConfigBody config={comparison.config} />}
      </VStack>
    </Card>
  );
}

function ComparisonBody({ comparison }: { comparison: HostHistoryComparison }) {
  const t = useTranslations("hostHistory");
  if (comparison.changes.length === 0) return <Banner status="info" title={t("noChanges")} />;
  return <AuditChanges changes={comparison.changes} layout="unified" />;
}

function ConfigBody({ config }: { config: ConfigDiff | null | undefined }) {
  const tSettings = useTranslations("settings");
  if (config === undefined) return null;
  if (config === null) return <Banner status="warning" title={tSettings("history.configFailed")} />;
  if (config.unchanged) return <Banner status="info" title={tSettings("reviewNoConfigChange")} />;
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <Heading level={5} accessibilityLevel={3}>
          {tSettings("reviewTabConfig")}
        </Heading>
        <StackItem size="fill" />
        <Text type="supporting" color="secondary">
          {tSettings("reviewDiffStat", { added: config.added, removed: config.removed })}
        </Text>
      </HStack>
      <DiffView lines={config.lines} />
      <Text type="supporting" color="secondary">
        {tSettings("reviewSecretsMasked")}
      </Text>
    </VStack>
  );
}

function RestoreRow({
  revisionId,
  restore,
}: {
  revisionId: number;
  restore: NonNullable<Props["restore"]>;
}) {
  const t = useTranslations("hostHistory");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionState | null>(null);
  const references = useTranslations("hostHistory.references") as unknown as DynamicTranslate;

  const submit = () => {
    setResult(null);
    startTransition(async () => {
      const outcome = await restore.action(revisionId, restore.missing.length > 0);
      setResult(outcome);
      if (outcome.status === "success") {
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <VStack gap={3}>
      <HStack gap={3} vAlign="center">
        <Text type="supporting" color="secondary" className="grow">
          {t("restoreHelp", { id: revisionId })}
        </Text>
        <Button
          variant="primary"
          size="sm"
          label={tCommon("restore")}
          onClick={() => setOpen(true)}
          data-testid="restore-host"
        />
      </HStack>
      {result && !open && (
        <Banner
          status={result.status === "success" ? "success" : "error"}
          title={result.message ?? ""}
        />
      )}
      {open && (
        <AppDialog
          open
          onClose={() => setOpen(false)}
          title={t("restoreTitle", { name: restore.name })}
          submitLabel={tCommon("restore")}
          onSubmit={submit}
          isSubmitting={pending}
        >
          <VStack gap={3}>
            <Text>{t("restoreHelp", { id: revisionId })}</Text>
            {restore.missing.length > 0 && (
              <VStack gap={2}>
                <Text>{t("restoreMissing", { id: revisionId })}</Text>
                <List density="compact">
                  {restore.missing.map((ref) => (
                    <ListItem
                      key={`${ref.kind}-${ref.id}`}
                      label={references(ref.kind, { id: ref.id })}
                    />
                  ))}
                </List>
                {restore.missing.some((ref) => ref.kind === "agent") && (
                  <Text type="supporting" color="secondary">
                    {t("restoreMissingAgents")}
                  </Text>
                )}
              </VStack>
            )}
            {result?.status === "error" && <Banner status="error" title={result.message ?? ""} />}
          </VStack>
        </AppDialog>
      )}
    </VStack>
  );
}
