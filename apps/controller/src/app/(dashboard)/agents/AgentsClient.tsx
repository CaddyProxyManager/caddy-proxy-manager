"use client";

/** Rows show pinned hosts, not served ones: every unassigned host lands on all agents. */

import { useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusChip } from "@/components/ui/StatusChip";
import { StatTiles } from "@/components/ui/StatTiles";
import { useEmptyValue } from "@/components/ui/empty-value";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Timestamp } from "@/components/ui/Timestamp";
import type { LogAccessFix } from "@/src/lib/agent/log-access";
import { rebuildAgentCaddyAction, renameAgentAction } from "./actions";

export type AgentRow = {
  id: number;
  name: string;
  enabled: boolean;
  connected: boolean;
  lastSeenAt: string | null;
  version: string | null;
  buildState: string;
  buildMessage: string | null;
  hasOwnBuildSettings: boolean;
  assignedHttpHosts: number;
  assignedL4Hosts: number;
  canManage: boolean;
  /** Each with the command that fixes it. */
  logAccessFixes: LogAccessFix[];
  /** The last configuration this agent's Caddy refused, until one loads again. */
  applyFailure: ApplyFailure | null;
};

export type ApplyFailure = { at: string; error: string };

/** Past this the banner clamps the message and offers the whole of it below. */
const APPLY_ERROR_PREVIEW_CHARS = 240;

function ApplyFailureBanner({ failure, title }: { failure: ApplyFailure; title: string }) {
  const t = useTranslations("agents");
  const long = failure.error.length > APPLY_ERROR_PREVIEW_CHARS;
  return (
    <Banner
      status="error"
      title={title}
      description={
        <VStack gap={1}>
          <Text type="body" size="sm">
            {t.rich("applyRefusedAt", { time: () => <Timestamp value={failure.at} /> })}
          </Text>
          {/* React escapes it; Caddy's wording is shown, never rendered. */}
          <Text type="code" size="sm" maxLines={3} wordBreak="break-word">
            {failure.error}
          </Text>
        </VStack>
      }
    >
      {long ? (
        <Text type="code" size="sm" wordBreak="break-word">
          {failure.error}
        </Text>
      ) : undefined}
    </Banner>
  );
}

/** Relative while recent, absolute once "14 days ago" stops meaning anything. */
const LAST_SEEN_RELATIVE_MS = 48 * 60 * 60 * 1000;

export default function AgentsClient({
  agents,
  anyPaired,
  managesFleet,
  fleetApplyFailure = null,
}: {
  agents: AgentRow[];
  anyPaired: boolean;
  managesFleet: boolean;
  /** A refusal no one agent owns: a Caddy reached with no agent attached. */
  fleetApplyFailure?: ApplyFailure | null;
}) {
  const t = useTranslations("agents");
  const tCaddyModules = useTranslations("caddyModules");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const emptyValue = useEmptyValue();
  const router = useRouter();

  function describeFix(fix: LogAccessFix): string {
    const values = { path: fix.path, gid: fix.gid };
    switch (fix.kind) {
      case "groupMismatch":
        return t("logAccessGroupMismatch", values);
      case "unreadable":
        return t("logAccessUnreadable", values);
      case "notTruncatable":
        return t("logAccessNotTruncatable", values);
      case "cleanupBlocked":
        return t("logAccessCleanupBlocked", values);
    }
  }
  const [renaming, setRenaming] = useState<AgentRow | null>(null);
  const [newName, setNewName] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const connectedCount = agents.filter((agent) => agent.connected).length;
  const ownBuildCount = agents.filter((agent) => agent.hasOwnBuildSettings).length;
  // Pinned, not served: counting unassigned hosts would not reconcile with the host list.
  const pinnedHosts = agents.reduce(
    (sum, agent) => sum + agent.assignedHttpHosts + agent.assignedL4Hosts,
    0,
  );
  // One version across the fleet is the answer people want; anything else is the problem.
  const versions = new Set(agents.map((agent) => agent.version).filter(Boolean));
  const versionLabel =
    versions.size === 0
      ? emptyValue
      : versions.size === 1
        ? `v${[...versions][0]}`
        : `${versions.size}`;

  async function rebuild(agent: AgentRow) {
    setBusyId(agent.id);
    setMessage(null);
    const result = await rebuildAgentCaddyAction(agent.id);
    setBusyId(null);
    setMessage({ ok: result.status === "success", text: result.message ?? "" });
    router.refresh();
  }

  async function submitRename() {
    if (!renaming) return;
    const data = new FormData();
    data.set("name", newName);
    const result = await renameAgentAction(renaming.id, undefined, data);
    setMessage({ ok: result.status === "success", text: result.message ?? "" });
    setRenaming(null);
    router.refresh();
  }

  return (
    <VStack gap={6}>
      {/* Pairing lives in Settings, behind agents:write over every agent. */}
      <PageHeader
        title={tNav("agents")}
        action={managesFleet ? { label: t("pair"), href: "/settings/agent" } : undefined}
      />

      {message?.text && <Banner status={message.ok ? "success" : "error"} title={message.text} />}

      {fleetApplyFailure && (
        <ApplyFailureBanner failure={fleetApplyFailure} title={t("applyRefusedFleetTitle")} />
      )}

      {agents.length === 0 && (
        <EmptyState
          headingLevel={2}
          title={t("noneTitle")}
          description={
            anyPaired && !managesFleet ? t("noneGrantedDescription") : t("noneDescription")
          }
        />
      )}

      {agents.length > 0 && (
        <StatTiles
          tiles={[
            {
              id: "agents",
              label: tNav("agents"),
              value: agents.length,
              note: t("pinnedHostsNote", { count: pinnedHosts }),
            },
            {
              id: "connected",
              label: t("connected"),
              value: connectedCount,
              note: t("connectedNote", { count: agents.length }),
              accent:
                connectedCount < agents.length
                  ? {
                      label: t("offlineAccent", { count: agents.length - connectedCount }),
                      variant: "warning" as const,
                    }
                  : undefined,
            },
            {
              id: "builds",
              label: t("buildSelection"),
              value: ownBuildCount,
              note: t("ownBuildNote", { count: agents.length - ownBuildCount }),
            },
            {
              id: "versions",
              label: tCommon("version"),
              value: versionLabel,
              note: t("versionNote"),
            },
          ]}
        />
      )}

      <Grid columns={{ minWidth: 340, max: 3 }} gap={4}>
        {agents.map((agent) => (
          <Card key={agent.id} padding={4}>
            <VStack gap={3}>
              <HStack justify="between" vAlign="center" gap={4} wrap="wrap">
                <VStack gap={1}>
                  {/* The anchor Needs attention links a refused apply to. */}
                  <Heading level={2} id={`agent-${agent.id}`}>
                    {agent.name}
                  </Heading>
                  <Text type="body" size="sm" color="secondary">
                    {agent.version ? `v${agent.version}` : tCommon("never")}
                  </Text>
                </VStack>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <StatusChip
                    status={agent.connected ? "active" : "inactive"}
                    label={agent.connected ? t("connected") : t("notConnected")}
                  />
                  <Badge label={agent.hasOwnBuildSettings ? t("ownBuild") : t("fleetBuild")} />
                  {agent.canManage && (
                    <>
                      <Button
                        label={tCommon("rename")}
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setRenaming(agent);
                          setNewName(agent.name);
                        }}
                      />
                      <Button
                        label={tCaddyModules("rebuildCaddy")}
                        size="sm"
                        isDisabled={!agent.connected || busyId === agent.id}
                        onClick={() => void rebuild(agent)}
                      />
                    </>
                  )}
                </HStack>
              </HStack>

              {agent.applyFailure && (
                <ApplyFailureBanner failure={agent.applyFailure} title={t("applyRefusedTitle")} />
              )}

              <Divider />

              <HStack gap={6} wrap="wrap">
                <VStack gap={0}>
                  <Text type="body" size="sm" color="secondary">
                    {t("assignedHosts")}
                  </Text>
                  <Text type="body" size="sm">
                    {agent.assignedHttpHosts + agent.assignedL4Hosts}
                  </Text>
                </VStack>
                <VStack gap={0}>
                  <Text type="body" size="sm" color="secondary">
                    {t("buildState")}
                  </Text>
                  <Text type="body" size="sm">
                    {agent.buildState}
                  </Text>
                </VStack>
                <VStack gap={0}>
                  <Text type="body" size="sm" color="secondary">
                    {tCommon("lastSeen")}
                  </Text>
                  <Text type="body" size="sm">
                    {agent.lastSeenAt ? (
                      <Timestamp
                        value={agent.lastSeenAt}
                        style="dateTimeShort"
                        relativeWithinMs={LAST_SEEN_RELATIVE_MS}
                      />
                    ) : (
                      tCommon("never")
                    )}
                  </Text>
                </VStack>
              </HStack>

              <Text type="supporting">{t("unassignedHint")}</Text>

              {agent.logAccessFixes.length > 0 && (
                <Banner status="warning" title={t("logAccessTitle")}>
                  <VStack gap={3}>
                    {agent.logAccessFixes.map((fix) => (
                      <VStack key={`${fix.kind}:${fix.path}`} gap={1}>
                        <Text type="body" size="sm">
                          {describeFix(fix)}
                        </Text>
                        {/* CodeBlock owns the copy button. */}
                        <CodeBlock code={fix.command} width="100%" />
                      </VStack>
                    ))}
                  </VStack>
                </Banner>
              )}
              {agent.buildMessage && <Banner status="info" title={agent.buildMessage} />}
            </VStack>
          </Card>
        ))}
      </Grid>

      {renaming && (
        <AppDialog
          open
          onClose={() => setRenaming(null)}
          title={t("renameTitle")}
          submitLabel={tCommon("rename")}
          onSubmit={() => void submitRename()}
        >
          <TextInput label={tCommon("name")} value={newName} onChange={setNewName} isRequired />
        </AppDialog>
      )}
    </VStack>
  );
}
