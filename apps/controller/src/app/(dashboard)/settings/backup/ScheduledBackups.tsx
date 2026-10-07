"use client";

/**
 * Settings > Backup's scheduled half: where backups go, when they run, and how the last runs went.
 * Every change goes through ./actions; the page reloads the overview after each.
 */

import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Clock, FolderOpen, KeyRound, Link, MoreHorizontal, Plug, Plus } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
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
import { AUTOFILL_NEW_PASSWORD, NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { useTableDensity } from "@/components/ui/TableDensity";
import { Timestamp } from "@/components/ui/Timestamp";
import { type SchedulePreset, presetExpression, presetOf } from "@/src/lib/backup/presets";
import type { BackupDestinationView } from "@/src/lib/backup/destinations";
import type { ScheduleListItem } from "@/src/lib/backup/manage";
import type { BackupRun } from "@/src/lib/backup/runs";
import { formatBytes } from "../../analytics/explore/format";
import { type ActionResult, unwrap } from "@/src/lib/errors/action-result";
import {
  type BackupOverview,
  deleteDestinationAction,
  deleteScheduleAction,
  loadBackupOverviewAction,
  previewTimingAction,
  runScheduleNowAction,
  saveDestinationAction,
  saveScheduleAction,
  setScheduleEnabledAction,
  testDestinationAction,
} from "./actions";

/** `MIN_PASSPHRASE_LENGTH` in lib/backup/format.ts, which pulls node:crypto into the bundle. */
const MIN_PASSPHRASE = 12;

/** Catalog keys are camelCase; triggers are stored as written. */
const TRIGGER_KEY = { schedule: "schedule", "catch-up": "catchUp", manual: "manual" } as const;

const STATUS_COLOR = { succeeded: "green", failed: "red", running: "blue" } as const;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function RunStatus({ run }: { run: Pick<BackupRun, "status"> }) {
  const t = useTranslations("settings.backupSchedules");
  const status = run.status as keyof typeof STATUS_COLOR;
  return <Token size="sm" color={STATUS_COLOR[status] ?? "gray"} label={t(`status.${status}`)} />;
}

// ── Destinations ────────────────────────────────────────────────────────────

type DestinationForm = {
  name: string;
  kind: "s3" | "local";
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  virtualHostedStyle: boolean;
  path: string;
};

const EMPTY_DESTINATION: DestinationForm = {
  name: "",
  kind: "s3",
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  accessKeyId: "",
  secretAccessKey: "",
  virtualHostedStyle: false,
  path: "scheduled",
};

function DestinationDialog({
  editing,
  open,
  onClose,
  onSaved,
}: {
  editing: BackupDestinationView | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("settings.backupSchedules");
  const tCommon = useTranslations("common");
  const [form, setForm] = useState<DestinationForm>(EMPTY_DESTINATION);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(
      editing ? { ...EMPTY_DESTINATION, ...editing, secretAccessKey: "" } : EMPTY_DESTINATION,
    );
    setError(null);
    setTested(null);
  }, [open, editing]);

  const set = <K extends keyof DestinationForm>(key: K, value: DestinationForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      unwrap(await saveDestinationAction(editing?.id ?? null, form));
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTested(null);
    try {
      const result = await testDestinationAction(editing?.id ?? null, form);
      setTested(
        result.ok ? { ok: true, message: t("testPassed") } : { ok: false, message: result.error },
      );
    } catch (err) {
      setTested({ ok: false, message: message(err, t("testFailed")) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={editing ? t("editDestination") : t("addDestination")}
      maxWidth="lg"
      submitLabel={tCommon("save")}
      onSubmit={() => void save()}
      isSubmitting={saving}
      isSubmitDisabled={!form.name.trim()}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("saveFailed")} description={error} />}
        <TextInput
          label={tCommon("name")}
          isRequired
          size="sm"
          value={form.name}
          onChange={(value) => set("name", value)}
        />
        <SegmentedControl
          label={t("kind")}
          size="sm"
          value={form.kind}
          onChange={(value) => set("kind", value === "local" ? "local" : "s3")}
        >
          <SegmentedControlItem value="s3" label={t("kinds.s3")} />
          <SegmentedControlItem value="local" label={t("kinds.local")} />
        </SegmentedControl>
        {form.kind === "s3" ? (
          <>
            <TextInput
              startIcon={Link}
              {...NO_SPELLCHECK}
              label={t("endpoint")}
              isOptional
              size="sm"
              value={form.endpoint}
              onChange={(value) => set("endpoint", value)}
              placeholder="https://<account>.r2.cloudflarestorage.com"
              description={t("endpointHelp")}
            />
            <Grid columns={{ minWidth: 200, max: 2 }} gap={2}>
              <TextInput
                {...NO_SPELLCHECK}
                label={t("bucket")}
                isRequired
                size="sm"
                value={form.bucket}
                onChange={(value) => set("bucket", value)}
              />
              <TextInput
                {...NO_SPELLCHECK}
                label={t("region")}
                isOptional
                size="sm"
                value={form.region}
                onChange={(value) => set("region", value)}
                placeholder="us-east-1"
              />
              <TextInput
                {...NO_SPELLCHECK}
                label={t("accessKeyId")}
                isRequired
                size="sm"
                value={form.accessKeyId}
                onChange={(value) => set("accessKeyId", value)}
              />
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_NEW_PASSWORD}
                label={t("secretAccessKey")}
                type="password"
                size="sm"
                value={form.secretAccessKey}
                onChange={(value) => set("secretAccessKey", value)}
                description={editing?.hasSecret ? t("secretStored") : undefined}
              />
            </Grid>
            <Switch
              label={t("virtualHostedStyle")}
              description={t("virtualHostedStyleHelp")}
              value={form.virtualHostedStyle}
              onChange={(value) => set("virtualHostedStyle", value)}
            />
          </>
        ) : (
          <TextInput
            startIcon={FolderOpen}
            {...NO_SPELLCHECK}
            label={t("folder")}
            isRequired
            size="sm"
            value={form.path}
            onChange={(value) => set("path", value)}
            description={t("folderHelp")}
          />
        )}
        <TextInput
          {...NO_SPELLCHECK}
          label={t("prefix")}
          isOptional
          size="sm"
          value={form.prefix}
          onChange={(value) => set("prefix", value)}
          placeholder="cpm/"
          description={t("prefixHelp")}
        />
        <HStack>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<Plug />}
            label={testing ? tCommon("testing") : tCommon("test")}
            isLoading={testing}
            onClick={() => void test()}
          />
        </HStack>
        {tested && (
          <Banner
            status={tested.ok ? "success" : "error"}
            title={tested.ok ? tested.message : t("testFailed")}
            description={tested.ok ? undefined : tested.message}
          />
        )}
      </VStack>
    </AppDialog>
  );
}

function DestinationsCard({
  destinations,
  onChanged,
}: {
  destinations: BackupDestinationView[];
  onChanged: () => void;
}) {
  const t = useTranslations("settings.backupSchedules");
  const tCommon = useTranslations("common");
  const density = useTableDensity();
  const [editing, setEditing] = useState<BackupDestinationView | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<BackupDestinationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(destination: BackupDestinationView) {
    setError(null);
    try {
      unwrap(await deleteDestinationAction(destination.id));
      onChanged();
    } catch (err) {
      setError(message(err, t("deleteFailed")));
    } finally {
      setDeleting(null);
    }
  }

  type Row = BackupDestinationView & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (row) => (
        <Text type="body" size="sm" weight="semibold" maxLines={1}>
          {row.name}
        </Text>
      ),
    },
    {
      key: "kind",
      header: t("kind"),
      width: pixel(140),
      renderCell: (row) => <Token size="sm" color="gray" label={t(`kinds.${row.kind}`)} />,
    },
    {
      key: "where",
      header: t("where"),
      width: proportional(2),
      renderCell: (row) => (
        <Text type="code" size="sm" maxLines={1}>
          {row.kind === "local"
            ? `backups/${row.path}/${row.prefix}`
            : `${row.endpoint || "s3"}/${row.bucket}/${row.prefix}`}
        </Text>
      ),
    },
    {
      key: "actions",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(56),
      align: "end",
      renderCell: (row) => (
        <DropdownMenu
          hasChevron={false}
          alignment="end"
          button={{
            variant: "ghost",
            icon: <MoreHorizontal />,
            label: tCommon("actionsFor", { name: row.name }),
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
            { type: "divider" as const },
            {
              id: "delete",
              label: tCommon("delete"),
              variant: "destructive" as const,
              onClick: () => setDeleting(row),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={3} accessibilityLevel={2}>
            {t("destinationsTitle")}
          </Heading>
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
          {t("destinationsHelp")}
        </Text>
        {error && <Banner status="error" title={t("deleteFailed")} description={error} />}
        {destinations.length === 0 ? (
          <EmptyState
            title={t("destinationsEmptyTitle")}
            description={t("destinationsEmptyDescription")}
            isCompact
          />
        ) : (
          <Table
            density={density}
            data={destinations.map((destination) => ({ ...destination }))}
            columns={columns}
            idKey="id"
            hasHover
          />
        )}
      </VStack>
      {/* Mounted only while open: a closed form would still answer its labels to tests and AT. */}
      {open && (
        <DestinationDialog
          editing={editing}
          open={open}
          onClose={() => setOpen(false)}
          onSaved={onChanged}
        />
      )}
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={t("deleteDestinationTitle")}
        description={deleting ? t("deleteDestinationConfirm", { name: deleting.name }) : ""}
        actionLabel={tCommon("delete")}
        onAction={() => deleting && void remove(deleting)}
      />
    </Card>
  );
}

// ── Schedules ───────────────────────────────────────────────────────────────

type Frequency = SchedulePreset["kind"];

type ScheduleForm = {
  name: string;
  destinationId: string;
  frequency: Frequency;
  minute: number;
  hour: number;
  weekday: string;
  expression: string;
  timeZone: string;
  prefix: string;
  includeAuditLog: boolean;
  includeSettingsHistory: boolean;
  keepLast: number | null;
  keepDays: number | null;
  passphrase: string;
  confirmation: string;
  enabled: boolean;
};

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function toPreset(form: ScheduleForm): SchedulePreset {
  switch (form.frequency) {
    case "hourly":
      return { kind: "hourly", minute: form.minute };
    case "daily":
      return { kind: "daily", hour: form.hour, minute: form.minute };
    case "weekly":
      return {
        kind: "weekly",
        weekday: Number(form.weekday),
        hour: form.hour,
        minute: form.minute,
      };
    case "custom":
      return { kind: "custom", expression: form.expression };
  }
}

function formFor(schedule: ScheduleListItem | null, destinations: BackupDestinationView[]) {
  const base: ScheduleForm = {
    name: "",
    destinationId: destinations[0] ? String(destinations[0].id) : "",
    frequency: "daily",
    minute: 0,
    hour: 3,
    weekday: "0",
    expression: "0 3 * * *",
    timeZone: browserTimeZone(),
    prefix: "",
    includeAuditLog: false,
    includeSettingsHistory: false,
    keepLast: 14,
    keepDays: null,
    passphrase: "",
    confirmation: "",
    enabled: true,
  };
  if (!schedule) return base;
  const preset = presetOf(schedule.cron);
  return {
    ...base,
    name: schedule.name,
    destinationId: String(schedule.destinationId),
    frequency: preset.kind,
    minute: "minute" in preset ? preset.minute : 0,
    hour: "hour" in preset ? preset.hour : 3,
    weekday: preset.kind === "weekly" ? String(preset.weekday) : "0",
    expression: schedule.cron,
    timeZone: schedule.timeZone,
    prefix: schedule.prefix,
    includeAuditLog: schedule.includeAuditLog,
    includeSettingsHistory: schedule.includeSettingsHistory,
    keepLast: schedule.keepLast,
    keepDays: schedule.keepDays,
    enabled: schedule.enabled,
  };
}

const WEEKDAYS = ["0", "1", "2", "3", "4", "5", "6"] as const;

function ScheduleDialog({
  editing,
  open,
  destinations,
  onClose,
  onSaved,
}: {
  editing: ScheduleListItem | null;
  open: boolean;
  destinations: BackupDestinationView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("settings.backupSchedules");
  const tBackup = useTranslations("settings.backup");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const [form, setForm] = useState<ScheduleForm>(() => formFor(null, destinations));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timing, setTiming] = useState<{ nextRunAt: string } | { message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(formFor(editing, destinations));
    setError(null);
  }, [open, editing, destinations]);

  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const cron = presetExpression(toPreset(form));

  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = setTimeout(() => {
      previewTimingAction(cron, form.timeZone).then(
        (result) => current && setTiming(result.ok ? result.data : null),
        () => current && setTiming(null),
      );
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, cron, form.timeZone]);

  const passphraseRequired = editing === null || form.passphrase.length > 0;
  const mismatch = form.confirmation.length > 0 && form.confirmation !== form.passphrase;
  const passphraseOk =
    !passphraseRequired ||
    (form.passphrase.length >= MIN_PASSPHRASE && form.confirmation === form.passphrase);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await saveScheduleAction(editing?.id ?? null, {
        name: form.name,
        destinationId: Number(form.destinationId),
        cron,
        timeZone: form.timeZone,
        prefix: form.prefix,
        includeAuditLog: form.includeAuditLog,
        includeSettingsHistory: form.includeSettingsHistory,
        keepLast: form.keepLast,
        keepDays: form.keepDays,
        passphrase: form.passphrase,
        enabled: form.enabled,
      });
      unwrap(result);
      setForm((prev) => ({ ...prev, passphrase: "", confirmation: "" }));
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  const time = (
    <>
      {form.frequency !== "hourly" && (
        <NumberInput
          hasNumberSteppers
          label={t("hour")}
          size="sm"
          width={120}
          min={0}
          max={23}
          isIntegerOnly
          value={form.hour}
          onChange={(value) => set("hour", value ?? 0)}
        />
      )}
      <NumberInput
        hasNumberSteppers
        label={t("minute")}
        size="sm"
        width={120}
        min={0}
        max={59}
        isIntegerOnly
        value={form.minute}
        onChange={(value) => set("minute", value ?? 0)}
      />
    </>
  );

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={editing ? t("editSchedule") : t("addSchedule")}
      maxWidth="lg"
      submitLabel={tCommon("save")}
      onSubmit={() => void save()}
      isSubmitting={saving}
      isSubmitDisabled={!form.name.trim() || !form.destinationId || !passphraseOk}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("saveFailed")} description={error} />}
        <Grid columns={{ minWidth: 220, max: 2 }} gap={2}>
          <TextInput
            label={tCommon("name")}
            isRequired
            size="sm"
            value={form.name}
            onChange={(value) => set("name", value)}
          />
          <Selector
            label={t("destination")}
            size="sm"
            options={destinations.map((destination) => ({
              value: String(destination.id),
              label: destination.name,
            }))}
            value={form.destinationId}
            onChange={(value) => set("destinationId", value)}
          />
        </Grid>
        <Selector
          label={t("frequency")}
          size="sm"
          width={240}
          options={(["hourly", "daily", "weekly", "custom"] as const).map((kind) => ({
            value: kind,
            label: t(`frequencies.${kind}`),
          }))}
          value={form.frequency}
          onChange={(value) => {
            const frequency = value as Frequency;
            setForm((prev) => ({
              ...prev,
              frequency,
              expression:
                frequency === "custom" ? presetExpression(toPreset(prev)) : prev.expression,
            }));
          }}
        />
        {form.frequency === "custom" ? (
          <TextInput
            startIcon={Clock}
            {...NO_SPELLCHECK}
            label={t("expression")}
            size="sm"
            value={form.expression}
            onChange={(value) => set("expression", value)}
            description={t("expressionHelp")}
          />
        ) : (
          <HStack gap={2} wrap="wrap">
            {form.frequency === "weekly" && (
              <Selector
                label={t("weekday")}
                size="sm"
                width={180}
                options={WEEKDAYS.map((day) => ({
                  value: day,
                  // 2026-10-04 was a Sunday, cron's day 0.
                  label: format.dateTime(new Date(Date.UTC(2026, 9, 4 + Number(day), 12)), {
                    weekday: "long",
                    timeZone: "UTC",
                  }),
                }))}
                value={form.weekday}
                onChange={(value) => set("weekday", value)}
              />
            )}
            {time}
          </HStack>
        )}
        <TextInput
          {...NO_SPELLCHECK}
          label={t("timeZone")}
          size="sm"
          value={form.timeZone}
          onChange={(value) => set("timeZone", value)}
          description={t("timeZoneHelp")}
        />
        {timing && "nextRunAt" in timing && (
          <Text type="body" size="sm" color="secondary">
            {t("nextRunPreview", { cron })}{" "}
            <Timestamp value={timing.nextRunAt} style="dateTimeShort" />
          </Text>
        )}
        {timing && "message" in timing && timing.message && (
          <Banner status="error" title={t("timingInvalid")} description={timing.message} />
        )}
        <TextInput
          {...NO_SPELLCHECK}
          label={t("prefix")}
          isOptional
          size="sm"
          value={form.prefix}
          onChange={(value) => set("prefix", value)}
          placeholder="nightly/"
          description={t("schedulePrefixHelp")}
        />
        <Grid columns={{ minWidth: 200, max: 2 }} gap={2}>
          <NumberInput
            hasNumberSteppers
            label={t("keepLast")}
            isOptional
            size="sm"
            min={1}
            max={1000}
            isIntegerOnly
            value={form.keepLast}
            onChange={(value) => set("keepLast", value ?? null)}
          />
          <NumberInput
            hasNumberSteppers
            label={t("keepDays")}
            isOptional
            size="sm"
            min={1}
            max={3650}
            isIntegerOnly
            value={form.keepDays}
            onChange={(value) => set("keepDays", value ?? null)}
          />
        </Grid>
        <Text type="supporting">{t("retentionHelp")}</Text>
        <CheckboxInput
          label={tBackup("includeAuditLog")}
          value={form.includeAuditLog}
          onChange={(value) => set("includeAuditLog", value)}
        />
        <CheckboxInput
          label={tBackup("includeSettingsHistory")}
          value={form.includeSettingsHistory}
          onChange={(value) => set("includeSettingsHistory", value)}
        />
        <Grid columns={{ minWidth: 220, max: 2 }} gap={2}>
          <TextInput
            startIcon={KeyRound}
            {...AUTOFILL_NEW_PASSWORD}
            label={tBackup("passphrase")}
            type="password"
            size="sm"
            value={form.passphrase}
            onChange={(value) => set("passphrase", value)}
            description={
              editing ? t("passphraseKeep") : tBackup("passphraseHelp", { min: MIN_PASSPHRASE })
            }
          />
          <TextInput
            startIcon={KeyRound}
            {...AUTOFILL_NEW_PASSWORD}
            label={tBackup("passphraseConfirm")}
            type="password"
            size="sm"
            value={form.confirmation}
            onChange={(value) => set("confirmation", value)}
            status={
              mismatch ? { type: "error", message: tBackup("passphraseMismatch") } : undefined
            }
          />
        </Grid>
        <Banner
          status="info"
          title={t("passphraseStoredTitle")}
          description={t("passphraseStored")}
        />
        <Switch
          label={t("enabled")}
          value={form.enabled}
          onChange={(value) => set("enabled", value)}
        />
      </VStack>
    </AppDialog>
  );
}

function SchedulesCard({
  overview,
  onChanged,
}: {
  overview: BackupOverview;
  onChanged: () => void;
}) {
  const t = useTranslations("settings.backupSchedules");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const density = useTableDensity();
  const [editing, setEditing] = useState<ScheduleListItem | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<ScheduleListItem | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(work: () => Promise<ActionResult<unknown>>, fallback: string) {
    setError(null);
    try {
      unwrap(await work());
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      onChanged();
    }
  }

  async function runNow(schedule: ScheduleListItem) {
    setRunning(schedule.id);
    await act(async () => {
      const result = await runScheduleNowAction(schedule.id);
      if (result.ok && result.data?.status === "failed") {
        return { ok: false, error: result.data.error ?? t("runFailed") };
      }
      return result;
    }, t("runFailed"));
    setRunning(null);
  }

  type ScheduleRow = ScheduleListItem & { [key: string]: unknown };
  const scheduleColumns: TableColumn<ScheduleRow>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold" maxLines={1}>
            {row.name}
          </Text>
          <Text type="body" size="sm" color="secondary" maxLines={1}>
            {row.destinationName}
          </Text>
        </VStack>
      ),
    },
    {
      key: "cron",
      header: t("timing"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="code" size="sm">
            {row.cron}
          </Text>
          <Text type="body" size="sm" color="secondary" maxLines={1}>
            {row.timeZone}
          </Text>
        </VStack>
      ),
    },
    {
      key: "nextRunAt",
      header: t("nextRun"),
      width: pixel(180),
      renderCell: (row) =>
        row.nextRunAt ? (
          <Timestamp value={row.nextRunAt} style="dateTimeShort" />
        ) : (
          <Text type="body" size="sm" color="secondary">
            {tCommon("never")}
          </Text>
        ),
    },
    {
      key: "lastRun",
      header: t("lastRun"),
      width: pixel(130),
      renderCell: (row) =>
        row.lastRun ? (
          <RunStatus run={row.lastRun} />
        ) : (
          <Text type="body" size="sm" color="secondary">
            {tCommon("never")}
          </Text>
        ),
    },
    {
      key: "enabled",
      header: t("enabled"),
      width: pixel(100),
      renderCell: (row) => (
        <Switch
          label={t("enabledFor", { name: row.name })}
          isLabelHidden
          value={row.enabled}
          onChange={(value) =>
            void act(() => setScheduleEnabledAction(row.id, value), t("saveFailed"))
          }
        />
      ),
    },
    {
      key: "actions",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(56),
      align: "end",
      renderCell: (row) => (
        <DropdownMenu
          hasChevron={false}
          alignment="end"
          button={{
            variant: "ghost",
            icon: <MoreHorizontal />,
            label: tCommon("actionsFor", { name: row.name }),
            isIconOnly: true,
          }}
          items={[
            {
              id: "run",
              label: t("runNow"),
              isDisabled: running !== null,
              onClick: () => void runNow(row),
            },
            {
              id: "edit",
              label: tCommon("edit"),
              onClick: () => {
                setEditing(row);
                setOpen(true);
              },
            },
            { type: "divider" as const },
            {
              id: "delete",
              label: tCommon("delete"),
              variant: "destructive" as const,
              onClick: () => setDeleting(row),
            },
          ]}
        />
      ),
    },
  ];

  type RunRow = BackupRun & { [key: string]: unknown };
  const runColumns: TableColumn<RunRow>[] = [
    {
      key: "startedAt",
      header: t("started"),
      width: pixel(180),
      renderCell: (row) => <Timestamp value={row.startedAt} style="dateTimeShort" />,
    },
    {
      key: "scheduleName",
      header: t("schedule"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" maxLines={1}>
            {row.scheduleName ?? ""}
          </Text>
          <Text type="body" size="sm" color="secondary" maxLines={1}>
            {t(`triggers.${TRIGGER_KEY[row.trigger as keyof typeof TRIGGER_KEY] ?? "schedule"}`)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "status",
      header: tCommon("status"),
      width: pixel(130),
      renderCell: (row) => <RunStatus run={row} />,
    },
    {
      key: "bytes",
      header: t("size"),
      width: pixel(110),
      renderCell: (row) => (
        <Text type="body" size="sm">
          {row.bytes === null ? "" : formatBytes(format, row.bytes)}
        </Text>
      ),
    },
    {
      key: "detail",
      header: t("detail"),
      width: proportional(2),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary" maxLines={2}>
          {row.status === "failed" ? (row.error ?? "") : (row.objectKey ?? "")}
        </Text>
      ),
    },
  ];

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={3} accessibilityLevel={2}>
            {t("schedulesTitle")}
          </Heading>
          <Button
            size="sm"
            icon={<Plus />}
            label={tCommon("add")}
            isDisabled={overview.destinations.length === 0}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          />
        </HStack>
        <Text type="body" size="sm" color="secondary">
          {t("schedulesHelp")}
        </Text>
        {error && <Banner status="error" title={t("actionFailed")} description={error} />}
        {running !== null && (
          <Banner status="info" title={t("running")} description={t("runningHelp")} />
        )}
        {overview.schedules.length === 0 ? (
          <EmptyState
            title={t("schedulesEmptyTitle")}
            description={
              overview.destinations.length === 0
                ? t("schedulesNeedDestination")
                : t("schedulesEmptyDescription")
            }
            isCompact
          />
        ) : (
          <Table
            density={density}
            data={overview.schedules.map((schedule) => ({ ...schedule }))}
            columns={scheduleColumns}
            idKey="id"
            hasHover
          />
        )}
        {overview.runs.length > 0 && (
          <VStack gap={2}>
            <Heading level={4} accessibilityLevel={3}>
              {t("runsTitle")}
            </Heading>
            <Table
              density={density}
              data={overview.runs.map((run) => ({ ...run }))}
              columns={runColumns}
              idKey="id"
            />
          </VStack>
        )}
      </VStack>
      {open && (
        <ScheduleDialog
          editing={editing}
          open={open}
          destinations={overview.destinations}
          onClose={() => setOpen(false)}
          onSaved={onChanged}
        />
      )}
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={t("deleteScheduleTitle")}
        description={deleting ? t("deleteScheduleConfirm", { name: deleting.name }) : ""}
        actionLabel={tCommon("delete")}
        onAction={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void act(() => deleteScheduleAction(target.id), t("deleteFailed"));
        }}
      />
    </Card>
  );
}

/** Destinations and schedules, kept in step: a destination added shows up in the schedule form. */
export function ScheduledBackups({ initial }: { initial: BackupOverview }) {
  const [overview, setOverview] = useState(initial);
  const reload = useCallback(() => {
    loadBackupOverviewAction()
      .then(unwrap)
      .then(setOverview, (error: unknown) => {
        console.error("Failed to reload the backup schedules:", error);
      });
  }, []);
  return (
    <>
      <DestinationsCard destinations={overview.destinations} onChanged={reload} />
      <SchedulesCard overview={overview} onChanged={reload} />
    </>
  );
}
