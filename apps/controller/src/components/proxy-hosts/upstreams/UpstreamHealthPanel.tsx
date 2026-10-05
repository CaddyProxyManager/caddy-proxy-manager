"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { proxyHostUpstreamHealthAction } from "@/src/app/(dashboard)/proxy-hosts/actions";
import { Timestamp } from "@/components/ui/Timestamp";
import type {
  HostUpstreamHealth,
  UpstreamHealth,
  UpstreamHealthState,
} from "@/src/lib/proxy-hosts/upstream-health-summary";

type T = ReturnType<typeof useTranslations<"proxyHosts.upstreamHealth">>;

const DOT: Record<UpstreamHealthState, "success" | "error" | "neutral" | "warning"> = {
  healthy: "success",
  failing: "error",
  unchecked: "neutral",
  unreported: "warning",
  unknown: "neutral",
};

function stateLabel(state: UpstreamHealthState, t: T): string {
  return t(`state.${state}`);
}

function detail(upstream: UpstreamHealth, t: T): string {
  switch (upstream.state) {
    case "failing":
      return upstream.outOfRotation
        ? t("outOfRotation", { count: upstream.fails })
        : t("failingDetail", { count: upstream.fails });
    case "healthy":
      return t("healthyDetail");
    case "unchecked":
      return t("uncheckedDetail");
    case "unreported":
      return t("unreportedDetail");
    default:
      return t("unknownDetail");
  }
}

/** One line per agent when several serve the host, so a single failing one is visible. */
function agentBreakdown(upstream: UpstreamHealth, t: T): string | null {
  if (upstream.agents.length < 2) return null;
  return upstream.agents
    .map((agent) =>
      t("agentState", { agent: agent.name ?? t("caddy"), state: stateLabel(agent.state, t) }),
    )
    .join(" · ");
}

/** Read when the editor opens and on demand: Caddy's counters move by the second. */
export function UpstreamHealthPanel({ hostId }: { hostId: number }) {
  const t = useTranslations("proxyHosts.upstreamHealth");
  const [health, setHealth] = useState<HostUpstreamHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const result = await proxyHostUpstreamHealthAction(hostId);
      if (result.ok) {
        setHealth(result.health);
        setError(null);
      } else {
        setError(result.message);
      }
    });
  }, [hostId]);

  useEffect(load, [load]);

  const silent = health?.agents.filter((agent) => !agent.reachable) ?? [];

  return (
    <Card variant="muted" padding={4}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2}>
          <VStack gap={0}>
            <Text type="body" size="sm" weight="semibold">
              {t("title")}
            </Text>
            <Text type="body" size="xsm" color="secondary">
              {health
                ? t.rich("checkedAt", {
                    when: () => <Timestamp value={health.checkedAt} style="time" />,
                  })
                : t("loading")}
            </Text>
          </VStack>
          <IconButton
            variant="ghost"
            size="sm"
            label={t("refresh")}
            icon={<RefreshCw />}
            onClick={load}
            isDisabled={isPending}
          />
        </HStack>
        {error && <Banner status="error" title={error} />}
        {health && !health.healthChecks && (
          <Text type="body" size="xsm" color="secondary">
            {t("noHealthChecks")}
          </Text>
        )}
        {silent.length > 0 && (
          <Banner
            status="warning"
            title={t("agentsSilent", {
              count: silent.length,
              names: silent.map((agent) => agent.name ?? t("caddy")).join(", "),
            })}
          />
        )}
        {health && (
          <List density="compact" hasDividers>
            {health.upstreams.map((upstream) => (
              <ListItem
                key={upstream.upstream}
                label={
                  <Text type="code" size="sm">
                    {upstream.upstream}
                  </Text>
                }
                description={[detail(upstream, t), agentBreakdown(upstream, t)]
                  .filter(Boolean)
                  .join(" · ")}
                endContent={
                  <HStack gap={2} vAlign="center">
                    <StatusDot
                      variant={DOT[upstream.state]}
                      label={stateLabel(upstream.state, t)}
                    />
                    <Text type="body" size="sm" weight="semibold">
                      {stateLabel(upstream.state, t)}
                    </Text>
                  </HStack>
                }
              />
            ))}
          </List>
        )}
      </VStack>
    </Card>
  );
}
