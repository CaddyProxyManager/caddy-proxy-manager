"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { agentStatusMessage, type AgentStatusWords } from "@/src/lib/agent/status-message";

type PortsDiff = {
  currentPorts: string[];
  requiredPorts: string[];
  needsApply: boolean;
};

type PortsStatus = {
  state: "idle" | "pending" | "applying" | "applied" | "failed";
  appliedAt?: string;
  error?: string;
} & AgentStatusWords;

type PortsResponse = {
  diff: PortsDiff;
  status: PortsStatus;
  error?: string;
};

/** `5000-5010:5000-5010/udp` as `5000-5010/udp`: the controller always publishes a port as itself. */
function portLabel(mapping: string): string {
  const match = /^([\d-]+):([\d-]+)(\/udp)?$/.exec(mapping);
  return match && match[1] === match[2] ? `${match[1]}${match[3] ?? ""}` : mapping;
}

export function L4PortsApplyBanner({ refreshSignal }: { refreshSignal?: number }) {
  const t = useTranslations("l4ProxyHosts");
  const tRoot = useTranslations();
  const [data, setData] = useState<PortsResponse | null>(null);
  const [applying, setApplying] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/l4-ports");
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // ignore fetch errors
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Re-fetch when the parent signals a mutation (create/edit/delete/toggle)
  useEffect(() => {
    if (!refreshSignal) return;
    fetchStatus();
  }, [refreshSignal, fetchStatus]);

  // Keyed on the boolean, not on `data`: every poll result would otherwise restart the interval.
  const shouldPoll = data?.status.state === "pending" || data?.status.state === "applying";
  useEffect(() => {
    if (!shouldPoll) return;
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, [shouldPoll, fetchStatus]);

  const handleApply = async () => {
    setApplying(true);
    try {
      const res = await fetch("/api/l4-ports", { method: "POST" });
      if (res.ok) {
        await fetchStatus();
      }
    } catch {
      // ignore
    } finally {
      setApplying(false);
    }
  };

  if (!data) return null;

  const { diff, status } = data;

  if (!diff.needsApply && (status.state === "idle" || status.state === "applied")) {
    return null;
  }

  const isSpinning = status.state === "pending" || status.state === "applying";

  const bannerStatus =
    status.state === "failed"
      ? "error"
      : status.state === "applied"
        ? "success"
        : diff.needsApply
          ? "warning"
          : "info";

  return (
    <Banner
      status={bannerStatus}
      // Banner supplies its own status icon; only the in-flight spinner needs
      // to replace it.
      icon={isSpinning ? <Spinner size="sm" /> : undefined}
      title={
        diff.needsApply
          ? t("portsChangesPending")
          : (agentStatusMessage(tRoot, status) ?? t("portsStatus"))
      }
      description={
        <VStack gap={1}>
          {diff.needsApply && (
            <>
              <Text type="body" size="sm">
                {t("portsApplyDescription")}
              </Text>
              {diff.requiredPorts.length > 0 && (
                <HStack gap={1} wrap="wrap" vAlign="center">
                  <Text type="body" size="sm">
                    {t("required")}
                  </Text>
                  {diff.requiredPorts.map((p) => (
                    <Badge key={p} label={portLabel(p)} />
                  ))}
                </HStack>
              )}
            </>
          )}
          {status.state === "failed" && status.error && (
            <Text type="body" size="xsm">
              {status.error}
            </Text>
          )}
        </VStack>
      }
      endContent={
        diff.needsApply ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw />}
            label={tRoot("common.apply")}
            isLoading={applying}
            isDisabled={applying || isSpinning}
            onClick={handleApply}
          />
        ) : undefined
      }
    />
  );
}
