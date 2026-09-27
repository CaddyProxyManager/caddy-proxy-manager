"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import type { DomainReachability } from "@/src/lib/domain-reachability";
import type { LetsDebugResult } from "@/src/lib/letsdebug";

type Props = { hostId: number; hostName: string; open: boolean; onClose: () => void };

const VARIANT = {
  reached: "success",
  wildcard: "neutral",
  unresolved: "error",
  noAnswer: "error",
  otherServer: "warning",
} as const;

/** Each of a host's domains, checked the way an HTTP-01 challenge would reach it. */
export function ReachabilityDialog({ hostId, hostName, open, onClose }: Props) {
  const t = useTranslations("certificates.reachability");
  const [results, setResults] = useState<DomainReachability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outside, setOutside] = useState<Record<string, LetsDebugResult | "pending">>({});

  useEffect(() => {
    if (!open) return;
    setResults(null);
    setError(null);
    setOutside({});
    fetch(`/api/proxy-hosts/${hostId}/reachability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) setError(body.error ?? t("failed"));
        else setResults(body.results);
      })
      .catch(() => setError(t("failed")));
  }, [open, hostId, t]);

  const askOutside = async (domain: string) => {
    setOutside((current) => ({ ...current, [domain]: "pending" }));
    try {
      const response = await fetch(`/api/proxy-hosts/${hostId}/reachability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ letsDebug: domain }),
      });
      const body = await response.json();
      setOutside((current) => ({
        ...current,
        [domain]: response.ok ? body.letsDebug : { state: "unavailable" },
      }));
    } catch {
      setOutside((current) => ({ ...current, [domain]: { state: "unavailable" } }));
    }
  };

  return (
    <AppDialog open={open} onClose={onClose} title={t("title", { name: hostName })} maxWidth="md">
      <VStack gap={4}>
        <Text type="body" size="sm" color="secondary">
          {t("help")}
        </Text>
        {error && <Banner status="error" title={t("failed")} description={error} />}
        {!results && !error && (
          <Text type="body" size="sm" color="secondary">
            {t("checking")}
          </Text>
        )}
        {results?.map((result) => {
          const check = outside[result.domain];
          return (
            <VStack key={result.domain} gap={2}>
              <HStack gap={2} vAlign="center">
                <StatusDot variant={VARIANT[result.result]} label={t(`results.${result.result}`)} />
                <Text type="code" size="sm" weight="semibold">
                  {result.domain}
                </Text>
              </HStack>
              <Text type="body" size="sm">
                {result.result === "otherServer"
                  ? t("results.otherServerStatus", { status: String(result.status ?? "?") })
                  : t(`results.${result.result}`)}
              </Text>
              {result.addresses.length > 0 && (
                <Text type="body" size="xsm" color="secondary">
                  {t("addresses", { addresses: result.addresses.join(", ") })}
                </Text>
              )}
              {result.caa.length > 0 && (
                <Text type="body" size="xsm" color="secondary">
                  {t("caa", { records: result.caa.join("; ") })}
                </Text>
              )}
              {result.result !== "wildcard" && !check && (
                <HStack>
                  <Button
                    variant="ghost"
                    size="sm"
                    label={t("askOutside")}
                    onClick={() => askOutside(result.domain)}
                  />
                </HStack>
              )}
              {check === "pending" && (
                <Text type="body" size="xsm" color="secondary">
                  {t("outsidePending")}
                </Text>
              )}
              {check && check !== "pending" && check.state === "unavailable" && (
                <Text type="body" size="xsm" color="secondary">
                  {t("outsideUnavailable")}
                </Text>
              )}
              {check && check !== "pending" && check.state === "done" && (
                <VStack gap={1}>
                  {check.problems.length === 0 ? (
                    <Text type="body" size="xsm">
                      {t("outsideNoProblems")}
                    </Text>
                  ) : (
                    check.problems.map((problem) => (
                      <Text key={problem.name} type="body" size="xsm">
                        {t("outsideProblem", problem)}
                      </Text>
                    ))
                  )}
                </VStack>
              )}
            </VStack>
          );
        })}
        <Text type="body" size="xsm" color="secondary">
          {t("outsidePrivacy")}
        </Text>
      </VStack>
    </AppDialog>
  );
}
