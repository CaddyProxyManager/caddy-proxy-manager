"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { MoreHorizontal, Plus } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TimeInput } from "@astryxdesign/core/TimeInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { AppDialog } from "@/components/ui/AppDialog";
import { useTableDensity } from "@/components/ui/TableDensity";
import { Timestamp } from "@/components/ui/Timestamp";
import type { DigestRun, DigestView } from "@/src/lib/alerts/digests";
import {
  type AlertsOverview,
  deleteDigestAction,
  previewDigestAction,
  saveDigestAction,
  sendDigestNowAction,
} from "./actions";
import { message, useChannelName } from "./shared";

const RUN_COLOR = { running: "blue", sent: "green", partial: "orange", failed: "red" } as const;
type RunStatus = keyof typeof RUN_COLOR;

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The browser's zone list; a short fallback where `supportedValuesOf` is missing. */
function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

function RunToken({ run }: { run: Pick<DigestRun, "status"> }) {
  const t = useTranslations("alerts.digests");
  const status = (run.status in RUN_COLOR ? run.status : "failed") as RunStatus;
  return <Token size="sm" color={RUN_COLOR[status]} label={t(`runStatus.${status}`)} />;
}

/** Each channel's outcome of a run, with why one failed. */
function RunResult({
  run,
  nameOf,
}: {
  run: DigestRun;
  nameOf: (id: number, stored: string) => string;
}) {
  const t = useTranslations("alerts.digests");
  const status = (run.status in RUN_COLOR ? run.status : "failed") as RunStatus;
  return (
    <Banner
      status={status === "sent" ? "success" : status === "partial" ? "warning" : "error"}
      title={t(`runStatus.${status}`)}
      description={run.error ?? undefined}
      collapsible={false}
    >
      {run.results.length > 0 && (
        <VStack gap={1}>
          {run.results.map((result) => (
            <Text key={result.channelId} type="body" size="sm">
              {result.ok
                ? t("channelSent", { channel: nameOf(result.channelId, result.name) })
                : t("channelFailed", {
                    channel: nameOf(result.channelId, result.name),
                    error: result.error ?? "",
                  })}
            </Text>
          ))}
        </VStack>
      )}
    </Banner>
  );
}

type DigestForm = {
  name: string;
  time: string;
  timeZone: string;
  channelIds: string[];
  enabled: boolean;
};

function DigestDialog({
  editing,
  channels,
  onClose,
  onSaved,
}: {
  editing: DigestView | null;
  channels: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("alerts.digests");
  const tAlerts = useTranslations("alerts");
  const tProfile = useTranslations("profile.displayPreferences");
  const tCommon = useTranslations("common");
  const zones = useMemo(timeZones, []);
  const [form, setForm] = useState<DigestForm>(() =>
    editing
      ? {
          name: editing.name,
          time: editing.time,
          timeZone: editing.timeZone,
          channelIds: editing.channelIds.map(String),
          enabled: editing.enabled,
        }
      : {
          name: "",
          time: "08:00",
          timeZone: browserTimeZone(),
          channelIds: channels[0] ? [channels[0].value] : [],
          enabled: true,
        },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof DigestForm>(key: K, value: DigestForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveDigestAction(editing?.id ?? null, {
        ...form,
        channelIds: form.channelIds.map(Number),
      });
      onSaved();
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
      title={editing ? t("editTitle") : t("addTitle")}
      maxWidth="md"
      submitLabel={tCommon("save")}
      onSubmit={() => void save()}
      isSubmitting={saving}
      isSubmitDisabled={!form.name.trim() || !form.time || form.channelIds.length === 0}
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
        <Grid columns={{ minWidth: 200, max: 2 }} gap={2}>
          <TimeInput
            label={t("time")}
            isRequired
            size="sm"
            hourFormat="24h"
            value={form.time as never}
            onChange={(value) => set("time", value ? String(value).slice(0, 5) : "")}
          />
          <Selector
            label={tProfile("timeZone")}
            size="sm"
            hasSearch
            options={zones.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }))}
            value={form.timeZone}
            onChange={(value) => set("timeZone", String(value))}
          />
        </Grid>
        <MultiSelector
          label={tAlerts("tabs.channels")}
          size="sm"
          triggerDisplay="labels"
          isRequired
          options={channels}
          value={form.channelIds}
          onChange={(value) => set("channelIds", value)}
          description={t("channelsHelp")}
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

function PreviewDialog({ digest, onClose }: { digest: DigestView; onClose: () => void }) {
  const t = useTranslations("alerts.digests");
  const tCommon = useTranslations("common");
  const [preview, setPreview] = useState<{ subject: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    previewDigestAction(digest.id).then(
      (result) => current && setPreview(result),
      (err: unknown) => current && setError(message(err, t("previewFailed"))),
    );
    return () => {
      current = false;
    };
  }, [digest.id, t]);

  return (
    <AppDialog
      open
      onClose={onClose}
      title={t("previewTitle", { name: digest.name })}
      maxWidth="lg"
      actions={<Button variant="primary" label={tCommon("close")} onClick={onClose} />}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("previewFailed")} description={error} />}
        {!preview && !error && (
          <Text type="body" size="sm" color="secondary">
            {t("previewLoading")}
          </Text>
        )}
        {preview && (
          <>
            <Text type="body" size="sm" weight="semibold">
              {preview.subject}
            </Text>
            <CodeBlock code={preview.text} width="100%" isWrapped maxHeight={480} />
          </>
        )}
      </VStack>
    </AppDialog>
  );
}

export function DigestsTab({
  overview,
  onChanged,
}: {
  overview: AlertsOverview;
  onChanged: () => void;
}) {
  const t = useTranslations("alerts.digests");
  const tAlerts = useTranslations("alerts");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const density = useTableDensity();
  const channelName = useChannelName();
  const [editing, setEditing] = useState<DigestView | null>(null);
  const [open, setOpen] = useState(false);
  const [previewing, setPreviewing] = useState<DigestView | null>(null);
  const [deleting, setDeleting] = useState<DigestView | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [sent, setSent] = useState<{ name: string; run: DigestRun } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Push carries a line, not a report.
  const channels = overview.channels
    .filter((channel) => channel.builtin !== "push")
    .map((channel) => ({ value: String(channel.id), label: channelName(channel) }));
  const channelsById = new Map(overview.channels.map((channel) => [channel.id, channel]));

  async function act(work: () => Promise<unknown>, fallback: string) {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      onChanged();
    }
  }

  async function send(digest: DigestView) {
    setSending(digest.id);
    setSent(null);
    await act(async () => {
      const run = await sendDigestNowAction(digest.id);
      if (run) setSent({ name: digest.name, run });
    }, t("sendFailed"));
    setSending(null);
  }

  type Row = DigestView & { [key: string]: unknown };
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
      key: "time",
      header: t("time"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="code" size="sm">
            {row.time}
          </Text>
          <Text type="body" size="sm" color="secondary" maxLines={1}>
            {row.timeZone}
          </Text>
        </VStack>
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
      key: "nextRunAt",
      header: t("nextRun"),
      width: pixel(170),
      renderCell: (row) =>
        row.nextRunAt ? (
          <Timestamp value={row.nextRunAt} style="dateTimeShort" />
        ) : (
          <Token size="sm" color="gray" label={tAlerts("rules.state.off")} />
        ),
    },
    {
      key: "lastRun",
      header: t("lastRun"),
      width: pixel(130),
      renderCell: (row) =>
        row.lastRun ? (
          <RunToken run={row.lastRun} />
        ) : (
          <Text type="body" size="sm" color="secondary">
            {tCommon("never")}
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
            { id: "preview", label: t("preview"), onClick: () => setPreviewing(row) },
            {
              id: "send",
              label: t("send"),
              isDisabled: sending !== null,
              onClick: () => void send(row),
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

  return (
    <Card padding={6}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={2}>{t("title")}</Heading>
          <Button
            size="sm"
            icon={<Plus />}
            label={tCommon("add")}
            isDisabled={channels.length === 0}
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
        {sending !== null && <Banner status="info" title={t("sending")} />}
        {sent && (
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {sent.name}
            </Text>
            <RunResult
              run={sent.run}
              nameOf={(id, stored) => {
                const channel = channelsById.get(id);
                return channel ? channelName(channel) : stored;
              }}
            />
          </VStack>
        )}
        {overview.digests.length === 0 ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} isCompact />
        ) : (
          <Table
            density={density}
            data={overview.digests.map((digest) => ({ ...digest }))}
            columns={columns}
            idKey="id"
            hasHover
          />
        )}
      </VStack>
      {open && (
        <DigestDialog
          editing={editing}
          channels={channels}
          onClose={() => setOpen(false)}
          onSaved={onChanged}
        />
      )}
      {previewing && <PreviewDialog digest={previewing} onClose={() => setPreviewing(null)} />}
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={t("deleteTitle")}
        description={deleting ? t("deleteConfirm", { name: deleting.name }) : ""}
        actionLabel={tCommon("delete")}
        onAction={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void act(() => deleteDigestAction(target.id), t("deleteFailed"));
        }}
      />
    </Card>
  );
}
