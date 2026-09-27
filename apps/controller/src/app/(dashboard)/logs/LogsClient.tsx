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
import { type LogSource, type LogView, accessLine, isAcmeLine } from "@/src/lib/log-view";

type Agent = { agentId: string; name: string; canReadLogs: boolean };

/** Enough to scroll back through without the page growing without bound. */
const KEPT_LINES = 2000;
const POLL_MS = 2000;
const SOURCES: LogView[] = ["access", "waf", "caddy", "acme"];

/** The source the agent reads; ACME is Caddy's own output, filtered here. */
const agentSource = (view: LogView): LogSource => (view === "acme" ? "caddy" : view);

export default function LogsClient({
  agents,
  initialAgent,
  initialView,
  initialHost,
  accessLogEnabled,
}: {
  agents: Agent[];
  initialAgent: string | null;
  initialView: LogView;
  /** Set when opened from a host's Logs action: its access log, narrowed to its domains. */
  initialHost: string | null;
  accessLogEnabled: boolean;
}) {
  const t = useTranslations("logs");
  const readable = agents.filter((agent) => agent.canReadLogs);
  const [agentId, setAgentId] = useState(initialAgent ?? readable[0]?.agentId ?? null);
  const [view, setView] = useState<LogView>(initialView);
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
    let stopped = false;
    const run = generation.current;
    const poll = async () => {
      const params = new URLSearchParams({ agent: agentId, source: agentSource(view) });
      if (cursor.current) params.set("cursor", cursor.current);
      try {
        const response = await fetch(`/api/logs?${params}`);
        const body = await response.json();
        if (stopped || run !== generation.current) return;
        if (!response.ok) {
          setError(body.error ?? t("readFailed"));
          return;
        }
        setError(null);
        setMissing(Boolean(body.missing));
        cursor.current = body.cursor ?? cursor.current;
        if (body.lines.length > 0) {
          setLines((current) => [...current, ...body.lines].slice(-KEPT_LINES));
        }
      } catch {
        if (!stopped) setError(t("readFailed"));
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [agentId, view, following, t]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return lines.filter(
      (line) =>
        (view !== "acme" || isAcmeLine(line)) && (!needle || line.toLowerCase().includes(needle)),
    );
  }, [lines, filter, view]);

  const text = useMemo(
    () =>
      view === "access"
        ? shown.map((line) => accessLine(line) ?? line).join("\n")
        : shown.join("\n"),
    [shown, view],
  );

  if (readable.length === 0) {
    return (
      <VStack gap={4} padding={6}>
        <Heading level={1}>{t("title")}</Heading>
        <EmptyState title={t("noAgentTitle")} description={t("noAgentDescription")} />
      </VStack>
    );
  }

  return (
    <VStack gap={4} padding={6}>
      <Heading level={1}>{t("title")}</Heading>
      <HStack gap={3} vAlign="end" wrap="wrap">
        <SegmentedControl
          label={t("source")}
          value={view}
          onChange={(next) => setView(next as LogView)}
        >
          {SOURCES.map((source) => (
            <SegmentedControlItem key={source} value={source} label={t(`sources.${source}`)} />
          ))}
        </SegmentedControl>
        {readable.length > 1 && (
          <Selector
            label={t("agent")}
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
        <Banner status="info" title={t("accessOffTitle")} description={t("accessOffDescription")} />
      )}
      {missing && view !== "access" && (
        <Banner status="info" title={t("missingTitle")} description={t("missingDescription")} />
      )}
      {error && <Banner status="error" title={t("readFailed")} description={error} />}

      {shown.length === 0 ? (
        <Text type="body" size="sm" color="secondary">
          {following ? t("waiting") : t("empty")}
        </Text>
      ) : (
        <CodeBlock code={text} size="sm" width="100%" />
      )}
      <Text type="body" size="xsm" color="secondary">
        {t("showing", { shown: shown.length, kept: lines.length })}
      </Text>
    </VStack>
  );
}
