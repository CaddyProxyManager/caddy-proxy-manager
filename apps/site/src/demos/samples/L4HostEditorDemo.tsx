import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  CreateL4HostDialog,
  EditL4HostDialog,
} from "@cpm/controller/src/components/l4-proxy-hosts/L4HostDialogs";
import type { L4ProxyHost } from "@cpm/controller/src/lib/models/l4-proxy-hosts";
import { DemoSurface } from "../DemoSurface";
import { onL4HostSaved } from "../shims/l4-actions";

const AGENTS = [
  { id: 1, name: "bundled", connected: true, hasOwnBuildSettings: false },
  { id: 2, name: "edge-fra", connected: true, hasOwnBuildSettings: false },
];

/** "Contractors" has only passwords, so the editor leaves it out: nothing in it applies at layer 4. */
const ACCESS_LISTS = [
  { id: 1, name: "Office network", ipRuleCount: 2 },
  { id: 2, name: "Contractors", ipRuleCount: 0 },
  { id: 3, name: "VPN only", ipRuleCount: 1 },
];

/**
 * Two backends behind one port, health-checked, a PROXY protocol header so they see clients, and
 * the office network's IP rules in front.
 */
const POSTGRES: L4ProxyHost = {
  id: 1,
  name: "postgres",
  description: "Primary and replica. Failover is manual; see the runbook.",
  protocol: "tcp",
  listenAddress: ":5432",
  upstreams: ["db-1:5432", "db-2:5432"],
  matcherType: "none",
  matcherValue: [],
  tlsTermination: false,
  proxyProtocolVersion: "v2",
  proxyProtocolReceive: false,
  accessListId: 1,
  enabled: true,
  meta: null,
  loadBalancer: {
    enabled: true,
    policy: "least_conn",
    policyChoose: null,
    policyWeights: null,
    tryDuration: null,
    tryInterval: null,
    activeHealthCheck: { enabled: true, port: null, interval: "10s", timeout: "2s" },
    passiveHealthCheck: {
      enabled: true,
      failDuration: "30s",
      maxFails: 3,
    },
  },
  dnsResolver: null,
  upstreamDnsResolution: null,
  geoblock: null,
  geoblockMode: "merge",
  crowdsec: true,
  upstreamPortMode: "fixed",
  createdAt: "2026-09-01T12:00:00Z",
  updatedAt: "2026-09-01T12:00:00Z",
};

/** A range, each connection sent to the port it arrived on - so no active health check. */
const GAME_SERVERS: L4ProxyHost = {
  ...POSTGRES,
  id: 2,
  name: "game servers",
  description: null,
  protocol: "udp",
  listenAddress: ":27015-27030",
  upstreams: ["srcds"],
  proxyProtocolVersion: null,
  accessListId: null,
  loadBalancer: null,
  upstreamPortMode: "same",
};

const SHOWN = [
  "name",
  "protocol",
  "listenAddress",
  "matcherType",
  "matcherValue",
  "upstreams",
  "upstreamPortMode",
  "proxyProtocolVersion",
  "accessListId",
  "lbEnabled",
  "lbPolicy",
  "geoblockEnabled",
];

/** Prints what the form posted: the matcher and PROXY protocol choices are only visible there. */
export default function L4HostEditorDemo() {
  const [open, setOpen] = useState<"create" | "postgres" | "games" | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  useEffect(
    () =>
      onL4HostSaved(({ form }) => {
        const lines = SHOWN.flatMap((key) => {
          const value = String(form.get(key) ?? "").trim();
          return value ? [`${key}: ${value.replaceAll("\n", ", ")}`] : [];
        });
        setPosted(lines.join("\n"));
      }),
    [],
  );

  return (
    <DemoSurface>
      <VStack gap={3}>
        <HStack gap={2} wrap="wrap">
          <Button variant="primary" label="New L4 host" onClick={() => setOpen("create")} />
          <Button variant="secondary" label="Edit postgres" onClick={() => setOpen("postgres")} />
          <Button variant="secondary" label="Edit game servers" onClick={() => setOpen("games")} />
        </HStack>
        {posted ? (
          <VStack gap={1}>
            <Text size="sm" color="secondary">
              What the form posted:
            </Text>
            <CodeBlock code={posted} size="sm" width="100%" />
          </VStack>
        ) : (
          <Text size="sm" color="secondary">
            Save either one to see what it sends.
          </Text>
        )}
      </VStack>
      <CreateL4HostDialog
        open={open === "create"}
        onClose={() => setOpen(null)}
        agents={AGENTS}
        accessLists={ACCESS_LISTS}
      />
      {(open === "postgres" || open === "games") && (
        <EditL4HostDialog
          open
          key={open}
          host={open === "postgres" ? POSTGRES : GAME_SERVERS}
          onClose={() => setOpen(null)}
          agents={AGENTS}
          accessLists={ACCESS_LISTS}
          assignedAgentIds={[]}
        />
      )}
    </DemoSurface>
  );
}
