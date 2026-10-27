"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Pause, Play, Trash2 } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { SearchField } from "@/components/ui/SearchField";
import {
  HOST_LOG_VIEWS,
  type LogSource,
  type LogView,
  accessLine,
  isAcmeLine,
  isLineForHosts,
} from "@/src/lib/analytics/log-view";

type Agent = { agentId: string; name: string; canReadLogs: boolean };

/** Enough to scroll back through without the page growing without bound. */
const KEPT_LINES = 2000;
const SOURCES: readonly LogView[] = ["access", "waf", "caddy", "acme"];
const NO_HOSTS: readonly string[] = [];

/** The source the agent reads; ACME is Caddy's own output, filtered here. */
const agentSource = (view: LogView): LogSource => (view === "acme" ? "caddy" : view);

export default function LogsClient({
  agents,
  initialAgent,
  initialView,
  initialHost,
  accessLogEnabled,
  lockedHosts = NO_HOSTS,
  title,
}: {
  agents: Agent[];
  initialAgent: string | null;
  initialView: LogView;
  /** Set when opened from a host's Logs action: its access log, narrowed to its domains. */
  initialHost: string | null;
  accessLogEnabled: boolean;
  /** A host's tab: only lines for these names, from the sources that name one. */
  lockedHosts?: readonly string[];
  /** Under the host's own heading, in place of the page's. */
  title?: string;
}) {
  const t = useTranslations("logs");
  const tOverview = useTranslations("overview");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const readable = agents.filter((agent) => agent.canReadLogs);
  const locked = lockedHosts.length > 0;
  const sources = locked ? HOST_LOG_VIEWS : SOURCES;
  const lockedSet = useMemo(() => new Set(lockedHosts), [lockedHosts]);
  const [agentId, setAgentId] = useState(initialAgent ?? readable[0]?.agentId ?? null);
  const [view, setView] = useState<LogView>(sources.includes(initialView) ? initialView : "access");
  const [filter, setFilter] = useState(initialHost ?? "");
  const [following, setFollowing] = useState(true);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);

  const reset = useCallback(() => {
    generation.current += 1;
    cursor.current = null;
    setLines([]);
    setError(null);
    setMissing(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new agent or source starts over
  useEffect(() => reset(), [agentId, view]);

  useEffect(() => {
    if (!agentId || !following) return;
    const run = generation.current;
    const params = new URLSearchParams({ agent: agentId, source: agentSource(view) });
    // Resumes after Pause from where it stopped; the stream's own reconnects send Last-Event-ID.
    if (cursor.current) params.set("cursor", cursor.current);
    const stream = new EventSource(`/api/logs/stream?${params}`);

    const parse = <T,>(raw: string): T | null => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    };
    stream.addEventListener("lines", (event) => {
      const body = parse<{ lines?: string[]; cursor?: string | null; missing?: boolean }>(
        (event as MessageEvent<string>).data,
      );
      if (!body || run !== generation.current) return;
      setError(null);
      setMissing(Boolean(body.missing));
      cursor.current = body.cursor ?? cursor.current;
      const fresh = body.lines ?? [];
      if (fresh.length > 0) setLines((current) => [...current, ...fresh].slice(-KEPT_LINES));
    });
    stream.addEventListener("problem", (event) => {
      const body = parse<{ error?: string }>((event as MessageEvent<string>).data);
      if (run === generation.current) setError(body?.error ?? t("readFailed"));
    });
    // A drop reconnects by itself; a refusal (signed out, no permission) closes it for good.
    stream.addEventListener("error", () => {
      if (run === generation.current && stream.readyState === EventSource.CLOSED) {
        setError(t("readFailed"));
      }
    });
    return () => stream.close();
  }, [agentId, view, following, t]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return lines.filter(
      (line) =>
        (view !== "acme" || isAcmeLine(line)) &&
        (!locked || isLineForHosts(view, line, lockedSet)) &&
        (!needle || line.toLowerCase().includes(needle)),
    );
  }, [lines, filter, view, locked, lockedSet]);

  const text = useMemo(
    () =>
      view === "access"
        ? shown.map((line) => accessLine(line) ?? line).join("\n")
        : shown.join("\n"),
    [shown, view],
  );

  // A tab sits under the host's heading, inside the page's own padding.
  const heading = title ? (
    <Heading level={2}>{title}</Heading>
  ) : (
    <Heading level={1}>{tNav("logs")}</Heading>
  );
  const padding = title ? undefined : 6;

  if (readable.length === 0) {
    return (
      <VStack gap={4} padding={padding}>
        {/* A tab's title would only head the empty state's own. */}
        {!title && heading}
        <EmptyState
          headingLevel={2}
          title={t("noAgentTitle")}
          description={t("noAgentDescription")}
        />
      </VStack>
    );
  }

  return (
    <VStack gap={4} padding={padding}>
      {heading}
      <HStack gap={3} vAlign="end" wrap="wrap">
        <SegmentedControl
          label={t("source")}
          value={view}
          onChange={(next) => setView(next as LogView)}
        >
          {sources.map((source) => (
            <SegmentedControlItem key={source} value={source} label={t(`sources.${source}`)} />
          ))}
        </SegmentedControl>
        {readable.length > 1 && (
          <Selector
            label={tCommon("agent")}
            size="sm"
            options={readable.map((agent) => ({ value: agent.agentId, label: agent.name }))}
            value={agentId ?? ""}
            onChange={(next) => setAgentId(next as string)}
          />
        )}
        <SearchField
          value={filter}
          onChange={setFilter}
          placeholder={t("filter")}
          label={t("filter")}
        />
        <Button
          variant="secondary"
          size="sm"
          icon={following ? <Pause /> : <Play />}
          label={following ? t("pause") : t("follow")}
          onClick={() => setFollowing((current) => !current)}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 />}
          label={t("clear")}
          onClick={() => setLines([])}
        />
      </HStack>

      {view === "access" && !accessLogEnabled && (
        <Banner
          status="info"
          title={tOverview("loggingOffTitle")}
          description={t("accessOffDescription")}
        />
      )}
      {missing && view !== "access" && (
        <Banner status="info" title={t("missingTitle")} description={t("missingDescription")} />
      )}
      {error && <Banner role="alert" status="error" title={t("readFailed")} description={error} />}

      {shown.length === 0 ? (
        <Text type="body" size="sm" color="secondary">
          {following ? t("waiting") : t("empty")}
        </Text>
      ) : (
        <CodeBlock code={text} size="sm" width="100%" />
      )}
      <Text type="body" size="sm" color="secondary">
        {t("showing", { shown: shown.length, kept: lines.length })}
      </Text>
    </VStack>
  );
}
