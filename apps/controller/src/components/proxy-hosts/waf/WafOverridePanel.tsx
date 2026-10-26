"use client";

/**
 * The host page's override mode: start it, watch it run, then choose which of the rules it
 * tripped go into a new preset the host selects (lib/waf/override.ts). Rendered inside the
 * page's section card, which the presentational view owns.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { DataTable, type Column, useRowSelection } from "@/components/ui/DataTable";
import { Timestamp } from "@/components/ui/Timestamp";
import {
  applyWafOverrideAction,
  discardWafOverrideAction,
  finishWafOverrideAction,
  startWafOverrideAction,
  wafOverrideResultAction,
  wafOverrideStateAction,
} from "@/src/app/(dashboard)/proxy-hosts/waf-override-actions";
import type { WafOverrideResult } from "@/src/lib/models/waf-overrides";
import {
  type WafOverrideRule,
  type WafOverrideSession,
  isWafOverrideActive,
} from "@/src/lib/waf/override";

const POLL_MS = 10_000;

type RuleRow = WafOverrideRule & { key: string };

function Countdown({ until }: { until: string }) {
  const t = useTranslations("proxyHosts.wafOverride");
  const now = useNow({ updateInterval: 1000 });
  const left = Math.max(0, Date.parse(until) - now.getTime());
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return (
    <>
      {t("remaining", {
        minutes: String(minutes),
        seconds: String(seconds).padStart(2, "0"),
      })}
    </>
  );
}

export function WafOverridePanel({
  hostId,
  hostName,
  initialSession,
  detectedIp,
  canApply,
}: {
  hostId: number;
  hostName: string;
  initialSession: WafOverrideSession | null;
  /** The reader's address as the server read it; null where no proxy forwarded one. */
  detectedIp: string | null;
  /** Creating a preset takes security:write on top of the host. */
  canApply: boolean;
}) {
  const t = useTranslations("proxyHosts.wafOverride");
  const tCommon = useTranslations("common");
  const tAnalytics = useTranslations("analytics");
  const tWaf = useTranslations("waf");
  const format = useFormatter();
  const router = useRouter();
  const [session, setSession] = useState(initialSession);
  const [result, setResult] = useState<WafOverrideResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [isPending, startTransition] = useTransition();
  const active = session !== null && isWafOverrideActive(session);
  const ended = session !== null && !active;

  const rows: RuleRow[] = useMemo(
    () => (result?.rules ?? []).map((rule) => ({ ...rule, key: String(rule.ruleId) })),
    [result],
  );
  const [selected, setSelected] = useRowSelection(rows, "key");

  const loadResult = useCallback(
    (current: WafOverrideSession) => {
      startTransition(async () => {
        const loaded = await wafOverrideResultAction(hostId, current.id);
        if (loaded.status === "error") setError(loaded.message);
        else {
          setError(null);
          setResult(loaded.result);
        }
      });
    },
    [hostId],
  );

  // A session ends by Finish here, or by the sweep: the poll notices the latter.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const state = await wafOverrideStateAction(hostId);
      if (state.status === "success") setSession(state.session);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, hostId]);

  useEffect(() => {
    if (session && !active) loadResult(session);
  }, [session, active, loadResult]);

  useEffect(() => {
    if (!session || active) return;
    setName(
      t("presetNameDefault", {
        host: hostName,
        date: format.dateTime(new Date(session.startedAt), {
          dateStyle: "short",
          timeStyle: "short",
        }),
      }),
    );
  }, [session, active, hostName, format, t]);

  // Everything is selected to begin with: the usual answer is "all of them".
  useEffect(() => {
    setSelected(new Set(rows.map((row) => row.key)));
  }, [rows, setSelected]);

  const run = (action: () => Promise<{ status: string; message?: string }>) => {
    startTransition(async () => {
      const outcome = await action();
      if (outcome.status === "error") {
        setError(outcome.message ?? null);
        return;
      }
      setError(null);
      if (outcome.message) toast.success(outcome.message);
      const state = await wafOverrideStateAction(hostId);
      if (state.status === "success") {
        setSession(state.session);
        if (state.session === null) setResult(null);
      }
      router.refresh();
    });
  };

  const columns: Column<RuleRow>[] = [
    {
      id: "rule",
      label: tAnalytics("rule"),
      width: 110,
      render: (row) => (
        <Text type="code" size="sm">
          {row.ruleId}
        </Text>
      ),
    },
    {
      id: "message",
      label: tWaf("ruleMessage"),
      render: (row) => (
        <Text type="body" size="sm">
          {row.message || row.ruleId}
        </Text>
      ),
    },
    {
      id: "severity",
      label: tWaf("severity"),
      width: 110,
      render: (row) =>
        row.severity ? (
          <Badge
            variant={row.points >= 5 ? "error" : row.points >= 3 ? "warning" : "neutral"}
            label={row.severity.toLowerCase()}
          />
        ) : null,
    },
    {
      id: "hits",
      label: tAnalytics("hits"),
      width: 80,
      align: "right",
      render: (row) => (
        <Text type="code" size="sm">
          {format.number(row.hits)}
        </Text>
      ),
    },
    {
      id: "matched",
      label: t("matched"),
      render: (row) => (
        <VStack gap={0} className="cpm-cell-lines">
          {row.matches.map((match) => (
            <Text key={`${match.variable}:${match.data}`} type="code" size="sm" maxLines={1}>
              {[match.variable, match.data].filter(Boolean).join(": ")}
            </Text>
          ))}
        </VStack>
      ),
    },
    {
      id: "paths",
      label: tAnalytics("top.paths"),
      render: (row) => (
        <VStack gap={0} className="cpm-cell-lines">
          {row.paths.map((path) => (
            <Text key={path} type="code" size="sm" maxLines={1}>
              {path}
            </Text>
          ))}
        </VStack>
      ),
    },
  ];

  const chosen = rows.filter((row) => selected.has(row.key));

  return (
    <VStack gap={4}>
      {error && <Banner role="alert" status="error" title={error} />}

      {!session && (
        <>
          <Text type="body" size="sm" color="secondary">
            {t("description")}
          </Text>
          {detectedIp ? (
            <Text type="body" size="sm" color="secondary">
              {t("startFrom", { ip: detectedIp })}
            </Text>
          ) : (
            <TextInput
              label={t("address")}
              description={t("addressHelp")}
              placeholder="203.0.113.9"
              value={address}
              onChange={setAddress}
              isRequired
            />
          )}
          <HStack justify="end">
            <Button
              variant="primary"
              label={t("start")}
              onClick={() => run(() => startWafOverrideAction(hostId, detectedIp ? null : address))}
              isDisabled={isPending || (!detectedIp && !address.trim())}
            />
          </HStack>
        </>
      )}

      {session && active && (
        <>
          <Banner
            role="status"
            status="info"
            title={t("running", {
              ip: session.clientIp,
              until: format.dateTime(new Date(session.expiresAt), { timeStyle: "short" }),
            })}
            description={t.rich("runningHelp", {
              remaining: () => <Countdown until={session.expiresAt} />,
            })}
          />
          <HStack justify="end">
            <Button
              variant="primary"
              label={t("finish")}
              onClick={() => run(() => finishWafOverrideAction(hostId))}
              isDisabled={isPending}
            />
          </HStack>
        </>
      )}

      {session && ended && (
        <>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t.rich("ended", {
                when: () => <Timestamp value={session.endedAt ?? session.expiresAt} />,
              })}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("endedHelp", {
                ip: session.clientIp,
                from: format.dateTime(new Date(session.startedAt), { timeStyle: "short" }),
                to: format.dateTime(new Date(session.endedAt ?? session.expiresAt), {
                  timeStyle: "short",
                }),
              })}
              {result ? ` ${t("eventsRead", { count: result.events })}` : ""}
            </Text>
          </VStack>

          {result?.preset ? (
            <Banner
              role="status"
              status="success"
              title={t("applied", { name: result.preset.name })}
              description={t("appliedHelp")}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title={t("noRules")}
              description={result ? t("noRulesHelp") : undefined}
              isCompact
            />
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              keyField="key"
              loading={!result}
              selection={{
                selectedKeys: selected,
                onChange: setSelected,
                rowLabel: (row) => tWaf("ruleLabel", { id: String(row.ruleId) }),
              }}
            />
          )}

          {!result?.preset && rows.length > 0 && canApply && (
            <TextInput
              label={t("presetName")}
              description={t("presetNameHelp")}
              value={name}
              onChange={setName}
              isRequired
            />
          )}

          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
            <Text type="body" size="sm" color="secondary">
              {!result?.preset && rows.length > 0
                ? t("selectedCount", { count: chosen.length })
                : ""}
            </Text>
            <HStack gap={2}>
              <Button
                variant="ghost"
                label={t("refresh")}
                onClick={() => loadResult(session)}
                isDisabled={isPending}
              />
              {result?.preset ? (
                <Button
                  variant="secondary"
                  label={t("start")}
                  // Back to the start view, which asks for the address where none was forwarded.
                  onClick={() => {
                    setSession(null);
                    setResult(null);
                  }}
                  isDisabled={isPending}
                />
              ) : (
                <>
                  <Button
                    variant="secondary"
                    label={tCommon("discard")}
                    onClick={() => run(() => discardWafOverrideAction(hostId, session.id))}
                    isDisabled={isPending}
                  />
                  {canApply && (
                    <Button
                      variant="primary"
                      label={tCommon("apply")}
                      onClick={() =>
                        run(() =>
                          applyWafOverrideAction(
                            hostId,
                            session.id,
                            name,
                            chosen.map((row) => row.ruleId),
                          ),
                        )
                      }
                      isDisabled={isPending || chosen.length === 0 || !name.trim()}
                    />
                  )}
                </>
              )}
            </HStack>
          </HStack>
        </>
      )}
    </VStack>
  );
}
