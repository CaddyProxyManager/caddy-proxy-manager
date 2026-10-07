"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { KeyRound, Link, MoreHorizontal, Plug, Plus, Trash2 } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
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
import type { ChannelInput, ChannelView } from "@/src/lib/alerts/channels";
import {
  type ChannelTestOutcome,
  deleteChannelAction,
  saveChannelAction,
  testChannelAction,
} from "./actions";
import { message, useChannelName } from "./shared";

/** `CHANNEL_KINDS` in lib/alerts/channels, which pulls the secrets module into the bundle. */
const KINDS = ["webhook", "discord", "slack", "teams", "ntfy"] as const;
type Kind = (typeof KINDS)[number];

/** `MAX_HEADERS` in lib/alerts/channels, for the same reason. */
const MAX_HEADERS = 10;

/** Where a built-in channel is set up. */
const BUILTIN_HOME = { email: "/settings/email", push: "/profile" } as const;

type ChannelForm = {
  name: string;
  kind: Kind;
  enabled: boolean;
  url: string;
  signingSecret: string;
  headers: { name: string; value: string }[];
  server: string;
  topic: string;
  token: string;
  clearToken: boolean;
};

const EMPTY: ChannelForm = {
  name: "",
  kind: "webhook",
  enabled: true,
  url: "",
  signingSecret: "",
  headers: [],
  server: "https://ntfy.sh",
  topic: "",
  token: "",
  clearToken: false,
};

function formFor(channel: ChannelView | null): ChannelForm {
  if (!channel) return EMPTY;
  return {
    ...EMPTY,
    name: channel.name,
    kind: channel.kind as Kind,
    enabled: channel.enabled,
    headers: channel.headerNames.map((name) => ({ name, value: "" })),
    server: channel.server ?? "",
    topic: channel.topic ?? "",
  };
}

function inputOf(form: ChannelForm): ChannelInput {
  return {
    name: form.name,
    kind: form.kind,
    enabled: form.enabled,
    url: form.kind === "ntfy" ? null : form.url,
    signingSecret: form.kind === "webhook" ? form.signingSecret : null,
    headers: form.kind === "webhook" ? form.headers.filter((header) => header.name.trim()) : null,
    server: form.kind === "ntfy" ? form.server : null,
    topic: form.kind === "ntfy" ? form.topic : null,
    token: form.kind === "ntfy" ? form.token : null,
    clearToken: form.kind === "ntfy" ? form.clearToken : null,
  };
}

function TestResult({ result }: { result: ChannelTestOutcome }) {
  const t = useTranslations("alerts.channels");
  const format = useFormatter();
  if (!result.ok) {
    return <Banner status="error" title={t("testFailed")} description={result.message} />;
  }
  if (result.outcome === "accepted") {
    return <Banner status="info" title={t("testAccepted")} description={t("testAcceptedHelp")} />;
  }
  return (
    <Banner
      status="success"
      title={t("testDelivered")}
      description={
        result.recipients.length > 0
          ? t("testRecipients", { recipients: format.list(result.recipients) })
          : undefined
      }
    />
  );
}

function ChannelDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: ChannelView | null;
  onClose: () => void;
  onSaved: (signingSecret: string | null) => void;
}) {
  const t = useTranslations("alerts.channels");
  const tCommon = useTranslations("common");
  const [form, setForm] = useState<ChannelForm>(() => formFor(editing));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<ChannelTestOutcome | null>(null);

  const set = <K extends keyof ChannelForm>(key: K, value: ChannelForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const setHeader = (index: number, field: "name" | "value", value: string) =>
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.map((header, i) =>
        i === index ? { ...header, [field]: value } : header,
      ),
    }));

  const keeps = editing !== null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveChannelAction(editing?.id ?? null, inputOf(form));
      onSaved(saved.signingSecret);
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
      setTested(await testChannelAction(editing?.id ?? null, inputOf(form)));
    } catch (err) {
      setTested({ ok: false, message: message(err, t("testFailed")) });
    } finally {
      setTesting(false);
    }
  }

  const urlHelp = form.kind === "ntfy" ? undefined : t(`urlHelp.${form.kind}`);

  return (
    <AppDialog
      open
      onClose={onClose}
      title={editing ? t("editTitle") : t("addTitle")}
      maxWidth="lg"
      submitLabel={tCommon("save")}
      onSubmit={() => void save()}
      isSubmitting={saving}
      isSubmitDisabled={!form.name.trim()}
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
            label={t("kind")}
            size="sm"
            isDisabled={editing !== null}
            options={KINDS.map((kind) => ({ value: kind, label: t(`kinds.${kind}`) }))}
            value={form.kind}
            onChange={(value) => {
              set("kind", value as Kind);
              setTested(null);
            }}
          />
        </Grid>
        {form.kind === "ntfy" ? (
          <>
            <Grid columns={{ minWidth: 220, max: 2 }} gap={2}>
              <TextInput
                startIcon={Link}
                {...NO_SPELLCHECK}
                label={t("server")}
                isRequired
                size="sm"
                value={form.server}
                onChange={(value) => set("server", value)}
              />
              <TextInput
                {...NO_SPELLCHECK}
                label={t("topic")}
                isRequired
                size="sm"
                value={form.topic}
                onChange={(value) => set("topic", value)}
                description={t("topicHelp")}
              />
            </Grid>
            <TextInput
              startIcon={KeyRound}
              {...AUTOFILL_NEW_PASSWORD}
              label={t("token")}
              isOptional
              type="password"
              size="sm"
              value={form.token}
              onChange={(value) => set("token", value)}
              description={editing?.hasToken ? t("secretKept") : t("tokenHelp")}
            />
            {editing?.hasToken && (
              <Switch
                label={t("clearToken")}
                value={form.clearToken}
                onChange={(value) => set("clearToken", value)}
              />
            )}
          </>
        ) : (
          <TextInput
            startIcon={Link}
            {...NO_SPELLCHECK}
            label={t("url")}
            isRequired={!keeps}
            size="sm"
            value={form.url}
            onChange={(value) => set("url", value)}
            placeholder={keeps ? editing?.target : undefined}
            description={keeps ? t("urlKept") : urlHelp}
          />
        )}
        {form.kind === "webhook" && (
          <>
            <TextInput
              startIcon={KeyRound}
              {...AUTOFILL_NEW_PASSWORD}
              label={t("signingSecret")}
              isOptional
              type="password"
              size="sm"
              value={form.signingSecret}
              onChange={(value) => set("signingSecret", value)}
              description={editing?.hasSigningSecret ? t("secretKept") : t("signingSecretHelp")}
            />
            <VStack gap={2}>
              <Text type="body" size="sm" weight="semibold">
                {t("headers")}
              </Text>
              <Text type="supporting">{keeps ? t("headersKept") : t("headersHelp")}</Text>
              {form.headers.map((header, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until named
                <HStack key={index} gap={2} vAlign="end">
                  <TextInput
                    {...NO_SPELLCHECK}
                    label={t("headerName")}
                    size="sm"
                    value={header.name}
                    onChange={(value) => setHeader(index, "name", value)}
                  />
                  <TextInput
                    {...AUTOFILL_NEW_PASSWORD}
                    label={t("headerValue")}
                    type="password"
                    size="sm"
                    value={header.value}
                    onChange={(value) => setHeader(index, "value", value)}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 />}
                    label={tCommon("removeNamed", { name: header.name || t("headerName") })}
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        headers: prev.headers.filter((_, i) => i !== index),
                      }))
                    }
                  />
                </HStack>
              ))}
              <HStack>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<Plus />}
                  label={t("addHeader")}
                  isDisabled={form.headers.length >= MAX_HEADERS}
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      headers: [...prev.headers, { name: "", value: "" }],
                    }))
                  }
                />
              </HStack>
            </VStack>
          </>
        )}
        <Switch
          label={t("enabled")}
          value={form.enabled}
          onChange={(value) => set("enabled", value)}
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
        {tested && <TestResult result={tested} />}
      </VStack>
    </AppDialog>
  );
}

function ChannelState({ channel }: { channel: ChannelView }) {
  const t = useTranslations("alerts.channels");
  if (!channel.enabled) return <Token size="sm" color="gray" label={t("state.off")} />;
  if (channel.failures > 0) {
    return (
      <VStack gap={0}>
        <HStack>
          <Token size="sm" color="red" label={t("state.failing")} />
        </HStack>
        <Text type="body" size="sm" color="secondary" maxLines={2}>
          {t("failures", { count: channel.failures })}
        </Text>
        {channel.lastError && (
          <Text type="body" size="sm" color="secondary" maxLines={2}>
            {channel.lastError}
          </Text>
        )}
      </VStack>
    );
  }
  if (channel.lastSentAt) {
    return (
      <VStack gap={0}>
        <HStack>
          <Token size="sm" color="green" label={t("state.working")} />
        </HStack>
        <Text type="body" size="sm" color="secondary">
          {t("lastSent")} <Timestamp value={channel.lastSentAt} style="dateTimeShort" />
        </Text>
      </VStack>
    );
  }
  return <Token size="sm" color="gray" label={t("state.unused")} />;
}

export function ChannelsTab({
  channels,
  onChanged,
}: {
  channels: ChannelView[];
  onChanged: () => void;
}) {
  const t = useTranslations("alerts.channels");
  const tAlerts = useTranslations("alerts");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const density = useTableDensity();
  const channelName = useChannelName();
  const [editing, setEditing] = useState<ChannelView | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<ChannelView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [tested, setTested] = useState<{ name: string; result: ChannelTestOutcome } | null>(null);
  const [testing, setTesting] = useState<number | null>(null);

  async function remove(channel: ChannelView) {
    setError(null);
    try {
      await deleteChannelAction(channel.id);
    } catch (err) {
      setError(message(err, t("deleteFailed")));
    } finally {
      onChanged();
    }
  }

  async function test(channel: ChannelView) {
    setTesting(channel.id);
    setTested(null);
    try {
      setTested({ name: channelName(channel), result: await testChannelAction(channel.id, null) });
    } catch (err) {
      setTested({
        name: channelName(channel),
        result: { ok: false, message: message(err, t("testFailed")) },
      });
    } finally {
      setTesting(null);
      onChanged();
    }
  }

  type Row = ChannelView & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (row) => (
        <Text type="body" size="sm" weight="semibold" maxLines={1}>
          {channelName(row)}
        </Text>
      ),
    },
    {
      key: "kind",
      header: t("kind"),
      width: pixel(150),
      renderCell: (row) => (
        <Token
          size="sm"
          color={row.builtin ? "purple" : "gray"}
          label={row.builtin ? tAlerts("builtin") : t(`kinds.${row.kind as Kind}`)}
        />
      ),
    },
    {
      key: "target",
      header: t("target"),
      width: proportional(2),
      renderCell: (row) =>
        row.builtin ? (
          <Text type="body" size="sm" color="secondary" maxLines={2}>
            {t(`builtinTarget.${row.builtin}`)}
          </Text>
        ) : (
          <Text type="code" size="sm" maxLines={1}>
            {row.kind === "ntfy" ? `${row.target}/${row.topic ?? ""}` : row.target}
          </Text>
        ),
    },
    {
      key: "state",
      header: tCommon("status"),
      width: proportional(1),
      renderCell: (row) => <ChannelState channel={row} />,
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
            label: tCommon("actionsFor", { name: channelName(row) }),
            isIconOnly: true,
          }}
          items={
            row.builtin
              ? [
                  {
                    id: "test",
                    label: tCommon("test"),
                    isDisabled: testing !== null,
                    onClick: () => void test(row),
                  },
                  {
                    id: "configure",
                    label: tCommon("configure"),
                    onClick: () => router.push(BUILTIN_HOME[row.builtin as "email" | "push"]),
                  },
                ]
              : [
                  {
                    id: "test",
                    label: tCommon("test"),
                    isDisabled: testing !== null,
                    onClick: () => void test(row),
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
                ]
          }
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
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          />
        </HStack>
        <Text type="body" size="sm" color="secondary">
          {t("help")}
        </Text>
        {error && <Banner status="error" title={t("deleteFailed")} description={error} />}
        {testing !== null && <Banner status="info" title={tCommon("testing")} />}
        {tested && (
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {tested.name}
            </Text>
            <TestResult result={tested.result} />
          </VStack>
        )}
        {channels.length === 0 ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} isCompact />
        ) : (
          <Table
            density={density}
            data={channels.map((channel) => ({ ...channel }))}
            columns={columns}
            idKey="id"
            hasHover
          />
        )}
      </VStack>
      {/* Mounted only while open: a closed form would still answer its labels to tests and AT. */}
      {open && (
        <ChannelDialog
          editing={editing}
          onClose={() => setOpen(false)}
          onSaved={(signingSecret) => {
            onChanged();
            if (signingSecret) setSecret(signingSecret);
          }}
        />
      )}
      {secret !== null && (
        <AppDialog
          open
          onClose={() => setSecret(null)}
          title={t("signingSecretTitle")}
          maxWidth="md"
          actions={
            <Button variant="primary" label={tCommon("done")} onClick={() => setSecret(null)} />
          }
        >
          <VStack gap={3}>
            <Banner
              status="warning"
              title={t("signingSecretOnce")}
              description={t("signingSecretOnceHelp")}
            />
            <CodeBlock code={secret} width="100%" isWrapped />
          </VStack>
        </AppDialog>
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
          if (target) void remove(target);
        }}
      />
    </Card>
  );
}
