"use client";

/**
 * Restoring stages rather than applies, so the operator sees what going back does to the Caddy
 * config through the header's Review & apply, as for a hand edit.
 */

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useFormatter, useTranslations } from "next-intl";
import { Timestamp } from "@/src/components/ui/Timestamp";
import type { RevisionRow } from "@/src/lib/settings/apply";
import type { ConfigDiff } from "@/src/lib/settings/config-diff";
import type { RevisionComparison } from "@/src/lib/settings/revisions";
import { stagedChangeLabel } from "@/src/lib/settings/section-keys";
import type { StagedView } from "@/src/lib/settings/staged-view";
import { restoreRevisionAction } from "../actions";
import SettingsFrame from "../SettingsFrame";
import { DiffView, revisionSummary } from "../StagedChanges";

type Props = {
  staged: StagedView;
  revisions: RevisionRow[];
  page: number;
  perPage: number;
  total: number;
  ids: number[];
  latest: number;
  restorableFrom: number;
  selection: { from: number; to: number } | null;
  comparison: RevisionComparison | null;
};

export default function HistoryClient(props: Props) {
  const t = useTranslations("settings");
  const { revisions, selection, latest } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** `null` drops a parameter, so the server picks its default. */
  const navigate = (changes: Record<string, number | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) next.delete(name);
      else next.set(name, String(value));
    }
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <SettingsFrame sectionId={null} title={t("history.title")} staged={props.staged}>
      <VStack gap={5}>
        <Text type="supporting" color="secondary">
          {t("history.subtitle")}
        </Text>

        {latest === 0 ? (
          <Banner status="info" title={t("history.empty")} />
        ) : (
          <>
            <Card padding={0}>
              <VStack gap={0} data-testid="revision-list">
                <HStack gap={2} vAlign="center" padding={4}>
                  <Heading level={3}>{t("history.listTitle")}</Heading>
                </HStack>
                {revisions.map((revision) => (
                  <RevisionListRow
                    key={revision.id}
                    revision={revision}
                    latest={latest}
                    demoMode={props.staged.demoMode}
                    isSelected={selection?.to === revision.id}
                    // Only `to`: the server finds the revision before it, which the capped id list
                    // may not hold for an old page.
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
                restorableFrom={props.restorableFrom}
                onSelect={navigate}
              />
            )}
          </>
        )}
      </VStack>
    </SettingsFrame>
  );
}

function RevisionListRow({
  revision,
  latest,
  demoMode,
  isSelected,
  onView,
}: {
  revision: RevisionRow;
  latest: number;
  /** Every apply fails without a Caddy, so the demo labels it as itself rather than an error. */
  demoMode: boolean;
  isSelected: boolean;
  onView: () => void;
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  return (
    <>
      <Divider />
      <HStack
        gap={3}
        vAlign="center"
        paddingBlock={3}
        paddingInline={4}
        className={isSelected ? "bg-muted" : undefined}
        data-testid={`revision-${revision.id}`}
      >
        <Text type="code" size="sm" color="secondary">
          #{revision.id}
        </Text>
        <VStack gap={0} className="min-w-0 grow">
          <Text type="label" maxLines={1}>
            {revisionSummary(t, format, revision)}
          </Text>
          <Text type="supporting" color="secondary">
            {t("history.appliedBy", {
              name: revision.appliedByName ?? t("history.unknownUser"),
            })}{" "}
            · <Timestamp value={revision.appliedAt} style="dateTimeShort" />
          </Text>
        </VStack>
        {revision.id === latest && <Badge variant="success" label={t("history.current")} />}
        {revision.outcome === "failed" && (
          <Tooltip content={revision.error ?? ""}>
            {demoMode ? (
              <Badge variant="neutral" className="cpm-demo-badge" label={t("revisionDemo")} />
            ) : (
              <Badge variant="error" label={t("history.failed")} />
            )}
          </Tooltip>
        )}
        {!revision.recorded && (
          <Tooltip content={t("history.notRecordedHelp")}>
            <Badge label={t("history.notRecorded")} />
          </Tooltip>
        )}
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
  restorableFrom,
  onSelect,
}: {
  ids: number[];
  selection: { from: number; to: number };
  comparison: RevisionComparison | null;
  latest: number;
  restorableFrom: number;
  onSelect: (changes: Record<string, number | null>) => void;
}) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { from, to } = selection;
  // The selection can be older than the capped id list, from a paged row or a shared link.
  const optionIds = [...new Set([...ids, from, to])].filter((id) => id > 0).sort((a, b) => b - a);
  const options = optionIds.map((id) => ({
    value: String(id),
    label: t("history.revisionOption", { id }),
  }));
  const fromOptions = [...options, { value: "0", label: t("history.initial") }];
  const canRestore = to >= 1 && to < latest && to >= restorableFrom;

  const restore = () => {
    setResult(null);
    startTransition(async () => {
      const outcome = await restoreRevisionAction(to);
      setResult({ ok: outcome.success, message: outcome.message ?? "" });
      router.refresh();
    });
  };

  return (
    <Card padding={4}>
      <VStack gap={4} data-testid="revision-comparison">
        <HStack gap={3} vAlign="end" wrap="wrap">
          <Heading level={3}>{t("history.compareTitle")}</Heading>
          <StackItem size="fill" />
          <Selector
            label={t("history.compareFrom")}
            size="sm"
            options={fromOptions}
            value={String(from)}
            onChange={(value) => onSelect({ from: Number(value) })}
          />
          <Selector
            label={t("history.compareTo")}
            size="sm"
            options={options}
            value={String(to)}
            onChange={(value) => onSelect({ to: Number(value) })}
          />
        </HStack>

        {from === to ? (
          <Banner status="info" title={t("history.same")} />
        ) : (
          <Text type="supporting" color="secondary">
            {from === 0
              ? t("history.comparisonSubtitleInitial", { to })
              : t("history.comparisonSubtitle", { from, to })}
          </Text>
        )}

        {canRestore && (
          <HStack gap={3} vAlign="center">
            <Text type="supporting" color="secondary" className="grow">
              {t("history.restoreHelp", { id: to })}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("history.restore", { id: to })}
              onClick={restore}
              isDisabled={pending}
              data-testid="restore-revision"
            />
          </HStack>
        )}
        {result && <Banner status={result.ok ? "success" : "error"} title={result.message} />}

        {comparison && <ComparisonBody comparison={comparison} />}
      </VStack>
    </Card>
  );
}

function ComparisonBody({ comparison }: { comparison: RevisionComparison }) {
  const t = useTranslations("settings");
  const tNav = useTranslations("nav");
  if (comparison.keys === null) {
    return <Banner status="warning" title={t("history.notComparable")} />;
  }
  if (comparison.keys.length === 0) {
    return <Banner status="info" title={t("history.noChanges")} />;
  }

  return (
    <VStack gap={4}>
      <Heading level={4}>{tNav("settings")}</Heading>
      {comparison.keys.map((entry) => (
        <VStack key={entry.key} gap={2}>
          <DiffHeading title={stagedChangeLabel(t, entry)} diff={entry.diff} code={entry.key} />
          <DiffView lines={entry.diff.lines} />
        </VStack>
      ))}

      <Divider />
      {comparison.config === null ? (
        <Banner status="warning" title={t("history.configFailed")} />
      ) : (
        <VStack gap={2}>
          <DiffHeading title={t("reviewTabConfig")} diff={comparison.config} />
          {comparison.config.unchanged ? (
            <Banner status="info" title={t("reviewNoConfigChange")} />
          ) : (
            <DiffView lines={comparison.config.lines} />
          )}
          <Text type="supporting" color="secondary">
            {t("history.configNote")} {t("reviewSecretsMasked")}
          </Text>
        </VStack>
      )}
    </VStack>
  );
}

function DiffHeading({ title, diff, code }: { title: string; diff: ConfigDiff; code?: string }) {
  const t = useTranslations("settings");
  return (
    <HStack gap={2} vAlign="center">
      <Heading level={5}>{title}</Heading>
      {code && (
        <Text type="code" size="sm" color="secondary">
          {code}
        </Text>
      )}
      <StackItem size="fill" />
      <Text type="supporting" color="secondary">
        {t("reviewDiffStat", { added: diff.added, removed: diff.removed })}
      </Text>
    </HStack>
  );
}
