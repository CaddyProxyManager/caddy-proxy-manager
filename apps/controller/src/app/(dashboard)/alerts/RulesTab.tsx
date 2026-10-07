"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { MoreHorizontal, Plus } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { DateTimeInput, type ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { AppDialog } from "@/components/ui/AppDialog";
import { useTableDensity } from "@/components/ui/TableDensity";
import { Timestamp } from "@/components/ui/Timestamp";
import type { RuleInput, RuleView } from "@/src/lib/alerts/rule-store";
import { ATTENTION_CODES } from "@/src/lib/attention/types";
import { ALERT_METRICS } from "@/src/lib/notifications/events";
import {
  type AlertsOverview,
  deleteRuleAction,
  saveRuleAction,
  silenceRuleAction,
  testRuleAction,
} from "./actions";
import { message, SEVERITIES, SeverityToken, useChannelName, useRuleName } from "./shared";

const SOURCES = ["event", "attention", "signal", "metric"] as const;
type Source = (typeof SOURCES)[number];
const SCOPES = ["all", "hosts", "tags"] as const;
type Scope = (typeof SCOPES)[number];
type Metric = (typeof ALERT_METRICS)[number];

type RuleForm = {
  name: string;
  source: Source;
  categories: string[];
  codes: string[];
  signals: string[];
  metric: Metric;
  comparison: "above" | "below";
  threshold: number | null;
  minutes: number | null;
  scope: Scope;
  hostIds: string[];
  tags: string[];
  severity: string;
  channelIds: string[];
  quietMinutes: number | null;
  enabled: boolean;
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function categoriesOf(kinds: string[], overview: AlertsOverview): string[] {
  return overview.categories
    .filter((category) => category.kinds.some((kind) => kinds.includes(kind)))
    .map((category) => category.category);
}

function formFor(rule: RuleView | null, overview: AlertsOverview): RuleForm {
  const base: RuleForm = {
    name: "",
    source: "event",
    categories: [],
    codes: [],
    signals: [],
    metric: "serverErrorShare",
    comparison: "above",
    threshold: 5,
    minutes: 15,
    scope: "all",
    hostIds: [],
    tags: [],
    severity: "warning",
    channelIds: [],
    quietMinutes: 0,
    enabled: true,
  };
  if (!rule) return base;
  const config = rule.config;
  return {
    ...base,
    name: rule.name,
    source: rule.source,
    categories: categoriesOf(strings(config.kinds), overview),
    codes: strings(config.codes),
    signals: strings(config.signals),
    metric: (config.metric as Metric) ?? base.metric,
    comparison: config.comparison === "below" ? "below" : "above",
    threshold: typeof config.threshold === "number" ? config.threshold : base.threshold,
    minutes: typeof config.minutes === "number" ? config.minutes : base.minutes,
    scope: rule.scope,
    hostIds: rule.hostIds.map(String),
    tags: rule.tags,
    severity: rule.severity,
    channelIds: rule.channelIds.map(String),
    quietMinutes: rule.quietMinutes,
    enabled: rule.enabled,
  };
}

function inputOf(form: RuleForm, overview: AlertsOverview, builtin: boolean): RuleInput {
  const common = {
    severity: form.severity,
    channelIds: form.channelIds.map(Number),
    quietMinutes: form.quietMinutes ?? 0,
  };
  if (builtin) return common;
  return {
    ...common,
    name: form.name,
    source: form.source,
    kinds: overview.categories
      .filter((category) => form.categories.includes(category.category))
      .flatMap((category) => category.kinds),
    codes: form.codes,
    signals: form.signals,
    metric: form.metric,
    comparison: form.comparison,
    threshold: form.threshold,
    minutes: form.minutes,
    scope: form.scope,
    hostIds: form.hostIds.map(Number),
    tags: form.tags,
    enabled: form.enabled,
  };
}

function useSourceSummary(overview: AlertsOverview) {
  const t = useTranslations("alerts.rules");
  const tRoot = useTranslations();
  const format = useFormatter();
  const ruleName = useRuleName();
  return (rule: RuleView): string => {
    const config = rule.config;
    switch (rule.source) {
      case "event": {
        const picked = categoriesOf(strings(config.kinds), overview);
        return format.list(
          overview.categories
            .filter((category) => picked.includes(category.category))
            .map((category) => ruleName({ name: null, settingKey: category.settingKey })),
        );
      }
      case "attention":
        return format.list(
          strings(config.codes).map((code) =>
            tRoot(`alerts.codes.${code as (typeof ATTENTION_CODES)[number]}`),
          ),
        );
      case "signal":
        return format.list(
          strings(config.signals).map((signal) => t(`signals.${signal as SignalKey}`)),
        );
      case "metric":
        return t("metricSummary", {
          metric: t(`metrics.${(config.metric as Metric) ?? "requests"}`),
          comparison: config.comparison === "below" ? "below" : "above",
          threshold: Number(config.threshold ?? 0),
          minutes: Number(config.minutes ?? 0),
        });
    }
  };
}

type SignalKey = "serverErrorBurst" | "mitigationSpike" | "blockedConcentration";

function RuleDialog({
  editing,
  overview,
  onClose,
  onSaved,
}: {
  editing: RuleView | null;
  overview: AlertsOverview;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("alerts.rules");
  const tAlerts = useTranslations("alerts");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const tSeverity = useTranslations("attention.severity");
  const ruleName = useRuleName();
  const channelName = useChannelName();
  const [form, setForm] = useState<RuleForm>(() => formFor(editing, overview));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const builtin = editing?.builtin != null;

  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveRuleAction(editing?.id ?? null, inputOf(form, overview, builtin));
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  const sourcePicked =
    (form.source === "event" && form.categories.length > 0) ||
    (form.source === "attention" && form.codes.length > 0) ||
    (form.source === "signal" && form.signals.length > 0) ||
    (form.source === "metric" && form.threshold !== null && form.minutes !== null);
  const scopePicked =
    form.scope === "all" ||
    (form.scope === "hosts" && form.hostIds.length > 0) ||
    (form.scope === "tags" && form.tags.length > 0);
  const valid =
    form.channelIds.length > 0 &&
    (builtin || (form.name.trim() !== "" && sourcePicked && scopePicked));

  return (
    <AppDialog
      open
      onClose={onClose}
      title={editing ? t("editTitle") : tCommon("addRule")}
      maxWidth="lg"
      submitLabel={tCommon("save")}
      onSubmit={() => void save()}
      isSubmitting={saving}
      isSubmitDisabled={!valid}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("saveFailed")} description={error} />}
        {builtin && editing ? (
          <Banner
            status="info"
            title={ruleName(editing)}
            description={t("builtinHelp")}
            endContent={
              <Button
                variant="secondary"
                size="sm"
                label={tNav("settings")}
                href="/settings/email"
              />
            }
          />
        ) : (
          <>
            <TextInput
              label={tCommon("name")}
              isRequired
              size="sm"
              value={form.name}
              onChange={(value) => set("name", value)}
            />
            <SegmentedControl
              label={t("source")}
              size="sm"
              value={form.source}
              onChange={(value) => set("source", value as Source)}
            >
              {SOURCES.map((source) => (
                <SegmentedControlItem key={source} value={source} label={t(`sources.${source}`)} />
              ))}
            </SegmentedControl>
            <Text type="supporting">{t(`sourceHelp.${form.source}`)}</Text>
            {form.source === "event" && (
              <MultiSelector
                label={t("events")}
                size="sm"
                triggerDisplay="labels"
                hasSelectAll
                options={overview.categories.map((category) => ({
                  value: category.category,
                  label: ruleName({ name: null, settingKey: category.settingKey }),
                }))}
                value={form.categories}
                onChange={(value) => set("categories", value)}
              />
            )}
            {form.source === "attention" && (
              <MultiSelector
                label={t("codes")}
                size="sm"
                triggerDisplay="labels"
                hasSearch
                options={ATTENTION_CODES.map((code) => ({
                  value: code,
                  label: tAlerts(`codes.${code}`),
                }))}
                value={form.codes}
                onChange={(value) => set("codes", value)}
              />
            )}
            {form.source === "signal" && (
              <MultiSelector
                label={t("signalsLabel")}
                size="sm"
                triggerDisplay="labels"
                options={overview.signals.map((signal) => ({
                  value: signal,
                  label: t(`signals.${signal as SignalKey}`),
                }))}
                value={form.signals}
                onChange={(value) => set("signals", value)}
              />
            )}
            {form.source === "metric" && (
              <Grid columns={{ minWidth: 160, max: 4 }} gap={2}>
                <Selector
                  label={t("metric")}
                  size="sm"
                  options={ALERT_METRICS.map((metric) => ({
                    value: metric,
                    label: t(`metrics.${metric}`),
                  }))}
                  value={form.metric}
                  onChange={(value) => set("metric", value as Metric)}
                />
                <Selector
                  label={t("comparison")}
                  size="sm"
                  options={(["above", "below"] as const).map((comparison) => ({
                    value: comparison,
                    label: t(`comparisons.${comparison}`),
                  }))}
                  value={form.comparison}
                  onChange={(value) => set("comparison", value === "below" ? "below" : "above")}
                />
                <NumberInput
                  label={
                    form.metric === "serverErrorShare" ? t("thresholdPercent") : t("threshold")
                  }
                  size="sm"
                  min={0}
                  value={form.threshold}
                  onChange={(value) => set("threshold", value ?? null)}
                />
                <NumberInput
                  hasNumberSteppers
                  label={t("window")}
                  size="sm"
                  min={1}
                  max={overview.maxMetricMinutes}
                  isIntegerOnly
                  value={form.minutes}
                  onChange={(value) => set("minutes", value ?? null)}
                />
              </Grid>
            )}
            <SegmentedControl
              label={t("scope")}
              size="sm"
              value={form.scope}
              onChange={(value) => set("scope", value as Scope)}
            >
              {SCOPES.map((scope) => (
                <SegmentedControlItem key={scope} value={scope} label={t(`scopes.${scope}`)} />
              ))}
            </SegmentedControl>
            {form.scope !== "all" && <Text type="supporting">{t("scopeHelp")}</Text>}
            {form.scope === "hosts" && (
              <MultiSelector
                label={t("hosts")}
                size="sm"
                triggerDisplay="labels"
                hasSearch
                options={overview.hosts.map((host) => ({
                  value: String(host.id),
                  label: host.name,
                }))}
                value={form.hostIds}
                onChange={(value) => set("hostIds", value)}
              />
            )}
            {form.scope === "tags" && (
              <MultiSelector
                label={t("tags")}
                size="sm"
                triggerDisplay="badges"
                hasSearch
                options={overview.tags}
                value={form.tags}
                onChange={(value) => set("tags", value)}
              />
            )}
          </>
        )}
        <MultiSelector
          label={tAlerts("tabs.channels")}
          size="sm"
          triggerDisplay="labels"
          isRequired
          options={overview.channels.map((channel) => ({
            value: String(channel.id),
            label: channelName(channel),
          }))}
          value={form.channelIds}
          onChange={(value) => set("channelIds", value)}
        />
        <Grid columns={{ minWidth: 200, max: 2 }} gap={2}>
          <Selector
            label={t("severity")}
            size="sm"
            options={SEVERITIES.map((severity) => ({
              value: severity,
              label: tSeverity(severity),
            }))}
            value={form.severity}
            onChange={(value) => set("severity", value)}
          />
          <NumberInput
            hasNumberSteppers
            label={t("quietMinutes")}
            size="sm"
            min={0}
            max={overview.maxQuietMinutes}
            isIntegerOnly
            value={form.quietMinutes}
            onChange={(value) => set("quietMinutes", value ?? null)}
            description={t("quietHelp")}
          />
        </Grid>
        {!builtin && (
          <Switch
            label={t("enabled")}
            value={form.enabled}
            onChange={(value) => set("enabled", value)}
          />
        )}
      </VStack>
    </AppDialog>
  );
}

const SILENCE_PRESETS = { hour: 1, day: 24, week: 168 } as const;
type SilencePreset = keyof typeof SILENCE_PRESETS | "custom";

function SilenceDialog({
  rule,
  onClose,
  onSilenced,
}: {
  rule: RuleView;
  onClose: () => void;
  onSilenced: () => void;
}) {
  const t = useTranslations("alerts.rules");
  const ruleName = useRuleName();
  const [preset, setPreset] = useState<SilencePreset>("hour");
  const [until, setUntil] = useState<ISODateTimeString | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function silence() {
    setSaving(true);
    setError(null);
    try {
      const at =
        preset === "custom"
          ? new Date(until ?? "").toISOString()
          : new Date(Date.now() + SILENCE_PRESETS[preset] * 3_600_000).toISOString();
      await silenceRuleAction(rule.id, at);
      onSilenced();
      onClose();
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={t("silenceTitle", { name: ruleName(rule) })}
      maxWidth="sm"
      submitLabel={t("silence")}
      onSubmit={() => void silence()}
      isSubmitting={saving}
      isSubmitDisabled={preset === "custom" && !until}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("saveFailed")} description={error} />}
        <Text type="body" size="sm" color="secondary">
          {t("silenceHelp")}
        </Text>
        <Selector
          label={t("silenceFor")}
          size="sm"
          options={(["hour", "day", "week", "custom"] as const).map((value) => ({
            value,
            label: t(`silencePresets.${value}`),
          }))}
          value={preset}
          onChange={(value) => setPreset(value as SilencePreset)}
        />
        {preset === "custom" && (
          <DateTimeInput label={t("silenceUntil")} isRequired value={until} onChange={setUntil} />
        )}
      </VStack>
    </AppDialog>
  );
}

function RuleState({ rule }: { rule: RuleView }) {
  const t = useTranslations("alerts.rules");
  if (rule.silencedUntil && Date.parse(rule.silencedUntil) > Date.now()) {
    return (
      <VStack gap={0}>
        <HStack>
          <Token size="sm" color="yellow" label={t("state.silenced")} />
        </HStack>
        <Text type="body" size="sm" color="secondary">
          {t("silencedUntil")} <Timestamp value={rule.silencedUntil} style="dateTimeShort" />
        </Text>
      </VStack>
    );
  }
  return rule.on ? (
    <Token size="sm" color="green" label={t("state.on")} />
  ) : (
    <Token size="sm" color="gray" label={t("state.off")} />
  );
}

export function RulesTab({
  overview,
  onChanged,
}: {
  overview: AlertsOverview;
  onChanged: () => void;
}) {
  const t = useTranslations("alerts.rules");
  const tAlerts = useTranslations("alerts");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const density = useTableDensity();
  const ruleName = useRuleName();
  const channelName = useChannelName();
  const summary = useSourceSummary(overview);
  const [editing, setEditing] = useState<RuleView | null>(null);
  const [open, setOpen] = useState(false);
  const [silencing, setSilencing] = useState<RuleView | null>(null);
  const [deleting, setDeleting] = useState<RuleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ queued: boolean; name: string } | null>(null);

  async function act(work: () => Promise<unknown>, fallback: string) {
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      onChanged();
    }
  }

  const channelsById = new Map(overview.channels.map((channel) => [channel.id, channel]));

  type Row = RuleView & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(2),
      renderCell: (row) => (
        <VStack gap={1}>
          <Text type="body" size="sm" weight="semibold" maxLines={2}>
            {ruleName(row)}
          </Text>
          <HStack>
            <SeverityToken severity={row.severity} />
          </HStack>
        </VStack>
      ),
    },
    {
      key: "source",
      header: t("watches"),
      width: proportional(2),
      renderCell: (row) =>
        row.builtin ? (
          <Token size="sm" color="purple" label={tAlerts("builtin")} />
        ) : (
          <VStack gap={0}>
            <Text type="body" size="sm" maxLines={1}>
              {t(`sources.${row.source}`)}
            </Text>
            <Text type="body" size="sm" color="secondary" maxLines={2}>
              {summary(row)}
            </Text>
          </VStack>
        ),
    },
    {
      key: "scope",
      header: t("scope"),
      width: pixel(140),
      renderCell: (row) => (
        <Text type="body" size="sm" maxLines={2}>
          {row.scope === "hosts"
            ? tCommon("hostCount", { count: row.hostIds.length })
            : row.scope === "tags"
              ? format.list(row.tags)
              : t("scopes.all")}
        </Text>
      ),
    },
    {
      key: "channels",
      header: tAlerts("tabs.channels"),
      width: proportional(1),
      renderCell: (row) => (
        <Text type="body" size="sm" maxLines={2}>
          {format.list(
            row.channelIds.flatMap((id) => {
              const channel = channelsById.get(id);
              return channel ? [channelName(channel)] : [];
            }),
          )}
        </Text>
      ),
    },
    {
      key: "quietMinutes",
      header: t("quiet"),
      width: pixel(100),
      renderCell: (row) => (
        <Text type="body" size="sm">
          {t("quietValue", { minutes: row.quietMinutes })}
        </Text>
      ),
    },
    {
      key: "state",
      header: tCommon("status"),
      width: pixel(170),
      renderCell: (row) => <RuleState rule={row} />,
    },
    {
      key: "actions",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(56),
      align: "end",
      renderCell: (row) => {
        const silenced = row.silencedUntil !== null && Date.parse(row.silencedUntil) > Date.now();
        return (
          <DropdownMenu
            hasChevron={false}
            alignment="end"
            button={{
              variant: "ghost",
              icon: <MoreHorizontal />,
              label: tCommon("actionsFor", { name: ruleName(row) }),
              isIconOnly: true,
            }}
            items={[
              {
                id: "edit",
                label: tCommon("edit"),
                onClick: () => {
                  setEditing(row);
                  setOpen(true);
                },
              },
              {
                id: "test",
                label: tCommon("test"),
                onClick: () =>
                  void act(async () => {
                    const { queued } = await testRuleAction(row.id, ruleName(row));
                    setNotice({ queued, name: ruleName(row) });
                  }, t("testFailed")),
              },
              silenced
                ? {
                    id: "unsilence",
                    label: t("unsilence"),
                    onClick: () => void act(() => silenceRuleAction(row.id, null), t("saveFailed")),
                  }
                : { id: "silence", label: t("silence"), onClick: () => setSilencing(row) },
              ...(row.builtin
                ? []
                : [
                    { type: "divider" as const },
                    {
                      id: "delete",
                      label: tCommon("delete"),
                      variant: "destructive" as const,
                      onClick: () => setDeleting(row),
                    },
                  ]),
            ]}
          />
        );
      },
    },
  ];

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={2}>{t("title")}</Heading>
          <Button
            size="sm"
            icon={<Plus />}
            label={tCommon("add")}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          />
        </HStack>
        <Text type="body" size="sm" color="secondary">
          {t("help")}
        </Text>
        {error && <Banner status="error" title={tAlerts("actionFailed")} description={error} />}
        {notice && (
          <Banner
            status={notice.queued ? "success" : "warning"}
            title={notice.name}
            description={notice.queued ? t("testQueued") : t("testNoChannel")}
          />
        )}
        {overview.rules.length === 0 ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} isCompact />
        ) : (
          <Table
            density={density}
            data={overview.rules.map((rule) => ({ ...rule }))}
            columns={columns}
            idKey="id"
            hasHover
          />
        )}
      </VStack>
      {open && (
        <RuleDialog
          editing={editing}
          overview={overview}
          onClose={() => setOpen(false)}
          onSaved={onChanged}
        />
      )}
      {silencing && (
        <SilenceDialog rule={silencing} onClose={() => setSilencing(null)} onSilenced={onChanged} />
      )}
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={t("deleteTitle")}
        description={deleting ? t("deleteConfirm", { name: deleting.name }) : ""}
        actionLabel={tCommon("delete")}
        onAction={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void act(() => deleteRuleAction(target.id), t("deleteFailed"));
        }}
      />
    </Card>
  );
}
