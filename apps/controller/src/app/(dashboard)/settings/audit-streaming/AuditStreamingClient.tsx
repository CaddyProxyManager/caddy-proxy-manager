"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { FileText, KeyRound, Link, MoreHorizontal, Plug, Plus, Server } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { AppDialog } from "@/components/ui/AppDialog";
import { AUTOFILL_NEW_PASSWORD, NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { useTableDensity } from "@/components/ui/TableDensity";
import { Timestamp } from "@/components/ui/Timestamp";
import type { SinkInput, SinkView } from "@/src/lib/audit-stream/sinks";
import type { StagedView } from "@/src/lib/settings/staged-view";
import SettingsFrame from "../SettingsFrame";
import {
  type SinkTestOutcome,
  deleteSinkAction,
  loadSinksAction,
  saveSinkAction,
  testSinkAction,
} from "./actions";

/** `SINK_KINDS` and friends in lib/audit-stream/sinks, which pulls the secrets module in. */
const KINDS = ["syslog-udp", "syslog-tcp", "syslog-tls", "http", "file"] as const;
type Kind = (typeof KINDS)[number];
const KIND_KEY = {
  "syslog-udp": "syslogUdp",
  "syslog-tcp": "syslogTcp",
  "syslog-tls": "syslogTls",
  http: "http",
  file: "file",
} as const;
const ENCODINGS = ["identity", "gzip", "zstd"] as const;
type Encoding = (typeof ENCODINGS)[number];
const DEFAULT_PORT = { "syslog-udp": 514, "syslog-tcp": 514, "syslog-tls": 6514 } as const;
const DEFAULT_MAX_BYTES = 2048;
const MIN_MAX_BYTES = 480;
const MAX_MAX_BYTES = 65_507;

type SinkForm = {
  name: string;
  kind: Kind;
  enabled: boolean;
  includeSecurity: boolean;
  host: string;
  port: number | null;
  maxBytes: number | null;
  ca: string;
  url: string;
  encoding: Encoding;
  headerName: string;
  headerValue: string;
  clearHeaderValue: boolean;
  fileName: string;
};

const EMPTY: SinkForm = {
  name: "",
  kind: "syslog-tls",
  enabled: true,
  includeSecurity: false,
  host: "",
  port: null,
  maxBytes: DEFAULT_MAX_BYTES,
  ca: "",
  url: "",
  encoding: "identity",
  headerName: "Authorization",
  headerValue: "",
  clearHeaderValue: false,
  fileName: "audit.jsonl",
};

const isSyslog = (kind: Kind): kind is keyof typeof DEFAULT_PORT => kind.startsWith("syslog-");

function formFor(sink: SinkView | null): SinkForm {
  if (!sink) return EMPTY;
  return {
    ...EMPTY,
    name: sink.name,
    kind: sink.kind,
    enabled: sink.enabled,
    includeSecurity: sink.includeSecurity,
    host: sink.host ?? "",
    port: sink.port,
    maxBytes: sink.maxBytes ?? DEFAULT_MAX_BYTES,
    ca: sink.ca ?? "",
    encoding: sink.encoding ?? "identity",
    headerName: sink.headerName ?? EMPTY.headerName,
    fileName: sink.fileName ?? EMPTY.fileName,
  };
}

function inputOf(form: SinkForm): SinkInput {
  const syslog = isSyslog(form.kind);
  return {
    name: form.name,
    kind: form.kind,
    enabled: form.enabled,
    includeSecurity: form.includeSecurity,
    host: syslog ? form.host : null,
    port: syslog ? (form.port ?? DEFAULT_PORT[form.kind as keyof typeof DEFAULT_PORT]) : null,
    maxBytes: form.kind === "syslog-udp" ? form.maxBytes : null,
    ca: form.kind === "syslog-tls" || form.kind === "http" ? form.ca : null,
    url: form.kind === "http" ? form.url : null,
    encoding: form.kind === "http" ? form.encoding : null,
    headerName: form.kind === "http" ? form.headerName : null,
    headerValue: form.kind === "http" ? form.headerValue : null,
    clearHeaderValue: form.kind === "http" ? form.clearHeaderValue : null,
    fileName: form.kind === "file" ? form.fileName : null,
  };
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function TestResult({ result }: { result: SinkTestOutcome }) {
  const t = useTranslations("settings.auditStreaming");
  if (!result.ok) {
    return <Banner status="error" title={t("testFailed")} description={result.message} />;
  }
  return (
    <Banner
      status={result.encodingRefused ? "warning" : "success"}
      title={t("testDelivered")}
      description={result.encodingRefused ? t("testEncodingRefused") : undefined}
    />
  );
}

function SinkDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: SinkView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("settings.auditStreaming");
  const tChannels = useTranslations("alerts.channels");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [form, setForm] = useState<SinkForm>(() => formFor(editing));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<SinkTestOutcome | null>(null);

  const set = <K extends keyof SinkForm>(key: K, value: SinkForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTested(null);
  };
  const keepsUrl = editing?.kind === "http";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveSinkAction(editing?.id ?? null, inputOf(form));
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
      setTested(await testSinkAction(editing?.id ?? null, inputOf(form)));
    } catch (err) {
      setTested({ ok: false, message: message(err, t("testFailed")) });
    } finally {
      setTesting(false);
    }
  }

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
            options={KINDS.map((kind) => ({ value: kind, label: t(`kinds.${KIND_KEY[kind]}`) }))}
            value={form.kind}
            onChange={(value) => set("kind", value as Kind)}
          />
        </Grid>
        <Text type="supporting">{t(`kindHelp.${KIND_KEY[form.kind]}`)}</Text>

        {isSyslog(form.kind) && (
          <Grid columns={{ minWidth: 160, max: 2 }} gap={2}>
            <TextInput
              startIcon={Server}
              {...NO_SPELLCHECK}
              label={t("host")}
              isRequired
              size="sm"
              value={form.host}
              onChange={(value) => set("host", value)}
            />
            <NumberInput
              label={tCommon("port")}
              size="sm"
              min={1}
              max={65_535}
              isIntegerOnly
              hasClear
              placeholder={String(DEFAULT_PORT[form.kind])}
              value={form.port}
              onChange={(value) => set("port", value)}
            />
          </Grid>
        )}
        {form.kind === "syslog-udp" && (
          <NumberInput
            label={t("maxBytes")}
            description={t("maxBytesHelp", { min: MIN_MAX_BYTES, max: MAX_MAX_BYTES })}
            size="sm"
            width={200}
            min={MIN_MAX_BYTES}
            max={MAX_MAX_BYTES}
            isIntegerOnly
            value={form.maxBytes}
            onChange={(value) => set("maxBytes", value)}
          />
        )}

        {form.kind === "http" && (
          <>
            <TextInput
              startIcon={Link}
              {...NO_SPELLCHECK}
              label={tChannels("url")}
              isRequired={!keepsUrl}
              size="sm"
              value={form.url}
              onChange={(value) => set("url", value)}
              placeholder={keepsUrl ? editing?.target : undefined}
              description={keepsUrl ? tChannels("urlKept") : t("urlHelp")}
            />
            <Selector
              label={t("encoding")}
              description={t("encodingHelp")}
              size="sm"
              options={ENCODINGS.map((encoding) => ({
                value: encoding,
                label: t(`encodings.${encoding}`),
              }))}
              value={form.encoding}
              onChange={(value) => set("encoding", value as Encoding)}
            />
            <Grid columns={{ minWidth: 220, max: 2 }} gap={2}>
              <TextInput
                {...NO_SPELLCHECK}
                label={t("headerName")}
                size="sm"
                value={form.headerName}
                onChange={(value) => set("headerName", value)}
              />
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_NEW_PASSWORD}
                label={tChannels("headerValue")}
                isOptional
                type="password"
                size="sm"
                value={form.headerValue}
                onChange={(value) => set("headerValue", value)}
                description={
                  editing?.hasHeaderValue ? tChannels("secretKept") : t("headerValueHelp")
                }
              />
            </Grid>
            {editing?.hasHeaderValue && (
              <Switch
                label={t("clearHeaderValue")}
                value={form.clearHeaderValue}
                onChange={(value) => set("clearHeaderValue", value)}
              />
            )}
          </>
        )}

        {(form.kind === "syslog-tls" || form.kind === "http") && (
          <TextArea
            label={t("ca")}
            description={t("caHelp")}
            isOptional
            size="sm"
            rows={4}
            value={form.ca}
            onChange={(value) => set("ca", value)}
          />
        )}

        {form.kind === "file" && (
          <TextInput
            startIcon={FileText}
            {...NO_SPELLCHECK}
            label={t("fileName")}
            isRequired
            size="sm"
            value={form.fileName}
            onChange={(value) => set("fileName", value)}
            description={t("fileNameHelp")}
          />
        )}

        <Switch
          label={t("includeSecurity")}
          description={t("includeSecurityHelp")}
          value={form.includeSecurity}
          onChange={(value) => set("includeSecurity", value)}
        />
        <Switch
          label={tSettings("enabled")}
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

function SinkState({ sink }: { sink: SinkView }) {
  const t = useTranslations("settings.auditStreaming");
  const tChannels = useTranslations("alerts.channels");
  const behind = sink.auditLag + (sink.securityLag ?? 0);
  const token = !sink.enabled ? (
    <Token size="sm" color="gray" label={tChannels("state.off")} />
  ) : sink.failures > 0 ? (
    <Token size="sm" color="red" label={tChannels("state.failing")} />
  ) : behind > 0 ? (
    <Token size="sm" color="blue" label={t("state.behind")} />
  ) : (
    <Token size="sm" color="green" label={t("state.current")} />
  );
  return (
    <VStack gap={0}>
      <HStack>{token}</HStack>
      {sink.lastError && (
        <Text type="body" size="sm" color="secondary" maxLines={3}>
          {sink.lastError}
        </Text>
      )}
      {sink.lastDeliveredAt && (
        <Text type="body" size="sm" color="secondary">
          {t("lastDelivered")} <Timestamp value={sink.lastDeliveredAt} style="dateTimeShort" />
        </Text>
      )}
    </VStack>
  );
}

function Lag({ sink }: { sink: SinkView }) {
  const t = useTranslations("settings.auditStreaming");
  if (sink.auditLag === 0 && !sink.securityLag) {
    return (
      <Text type="body" size="sm" color="secondary">
        {t("state.current")}
      </Text>
    );
  }
  return (
    <VStack gap={0}>
      {sink.auditLag > 0 && (
        <Text type="body" size="sm">
          {t("lagAudit", { count: sink.auditLag })}
        </Text>
      )}
      {sink.securityLag ? (
        <Text type="body" size="sm">
          {t("lagSecurity", { count: sink.securityLag })}
        </Text>
      ) : null}
    </VStack>
  );
}

/** What a sink was told it missed, and an encoding it was refused: both need the reader to act. */
function SinkNotices({ sinks }: { sinks: SinkView[] }) {
  const t = useTranslations("settings.auditStreaming");
  const notices = sinks.flatMap((sink) => [
    ...(sink.gapStream && sink.gapFrom !== null && sink.gapTo !== null
      ? [
          <Banner
            key={`gap-${sink.id}`}
            status="warning"
            title={t("gapTitle", { name: sink.name })}
            description={t(sink.gapStream === "audit" ? "gapAudit" : "gapSecurity", {
              from: sink.gapFrom,
              to: sink.gapTo,
              missed: sink.missed,
            })}
          />,
        ]
      : []),
    ...(sink.encodingFallback && sink.encoding
      ? [
          <Banner
            key={`encoding-${sink.id}`}
            status="info"
            title={t("encodingFallbackTitle", { name: sink.name })}
            description={t("encodingFallback", { encoding: t(`encodings.${sink.encoding}`) })}
          />,
        ]
      : []),
  ]);
  return notices.length > 0 ? <VStack gap={2}>{notices}</VStack> : null;
}

export default function AuditStreamingClient({
  staged,
  initial,
}: {
  staged: StagedView;
  initial: SinkView[];
}) {
  const t = useTranslations("settings.auditStreaming");
  const tSettings = useTranslations("settings");
  const tChannels = useTranslations("alerts.channels");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const density = useTableDensity();
  const [sinks, setSinks] = useState(initial);
  const [editing, setEditing] = useState<SinkView | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<SinkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<{ name: string; result: SinkTestOutcome } | null>(null);
  const [testing, setTesting] = useState<number | null>(null);

  async function reload() {
    try {
      setSinks(await loadSinksAction());
    } catch {
      router.refresh();
    }
  }

  async function remove(sink: SinkView) {
    setError(null);
    try {
      await deleteSinkAction(sink.id);
    } catch (err) {
      setError(message(err, t("deleteFailed")));
    } finally {
      await reload();
    }
  }

  async function test(sink: SinkView) {
    setTesting(sink.id);
    setTested(null);
    try {
      setTested({ name: sink.name, result: await testSinkAction(sink.id, null) });
    } catch (err) {
      setTested({ name: sink.name, result: { ok: false, message: message(err, t("testFailed")) } });
    } finally {
      setTesting(null);
    }
  }

  type Row = SinkView & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold" maxLines={1}>
            {row.name}
          </Text>
          {row.includeSecurity && (
            <Text type="body" size="sm" color="secondary">
              {t("withSecurity")}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      key: "kind",
      header: t("kind"),
      width: pixel(170),
      renderCell: (row) => (
        <Token size="sm" color="gray" label={t(`kinds.${KIND_KEY[row.kind]}`)} />
      ),
    },
    {
      key: "target",
      header: tChannels("target"),
      width: proportional(1),
      renderCell: (row) => (
        <Text type="code" size="sm" maxLines={1}>
          {row.target}
        </Text>
      ),
    },
    {
      key: "lag",
      header: t("lag"),
      width: pixel(170),
      renderCell: (row) => <Lag sink={row} />,
    },
    {
      key: "state",
      header: tCommon("status"),
      width: proportional(1),
      renderCell: (row) => <SinkState sink={row} />,
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
          ]}
        />
      ),
    },
  ];

  return (
    <SettingsFrame
      sectionId={null}
      title={tSettings("auditStreaming.navLabel")}
      staged={staged}
      aside={false}
    >
      <Card padding={6}>
        <VStack gap={3}>
          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
            <Heading level={3} accessibilityLevel={2}>
              {t("sinksTitle")}
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
            {t("help")}
          </Text>
          {error && <Banner status="error" title={t("deleteFailed")} description={error} />}
          <SinkNotices sinks={sinks} />
          {testing !== null && <Banner status="info" title={tCommon("testing")} />}
          {tested && (
            <VStack gap={1}>
              <Text type="body" size="sm" weight="semibold">
                {tested.name}
              </Text>
              <TestResult result={tested.result} />
            </VStack>
          )}
          {sinks.length === 0 ? (
            <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} isCompact />
          ) : (
            <Table
              density={density}
              data={sinks.map((sink) => ({ ...sink }))}
              columns={columns}
              idKey="id"
              hasHover
            />
          )}
        </VStack>
        {/* Mounted only while open: a closed form would still answer its labels to tests and AT. */}
        {open && (
          <SinkDialog
            editing={editing}
            onClose={() => setOpen(false)}
            onSaved={() => void reload()}
          />
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
    </SettingsFrame>
  );
}
