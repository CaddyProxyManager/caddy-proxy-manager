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

/** Two backends behind one port, health-checked, and a PROXY protocol header so they see clients. */
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
  enabled: true,
  meta: null,
  loadBalancer: {
    enabled: true,
    policy: "least_conn",
    policyChoose: null,
    policyWeights: null,
    tryDuration: null,
    tryInterval: null,
    retries: null,
    activeHealthCheck: { enabled: true, port: null, interval: "10s", timeout: "2s" },
    passiveHealthCheck: {
      enabled: true,
      failDuration: "30s",
      maxFails: 3,
      unhealthyLatency: null,
    },
  },
  dnsResolver: null,
  upstreamDnsResolution: null,
  geoblock: null,
  geoblockMode: "merge",
  createdAt: "2026-09-01T12:00:00Z",
  updatedAt: "2026-09-01T12:00:00Z",
};

const SHOWN = [
  "name",
  "protocol",
  "listenAddress",
  "matcherType",
  "matcherValue",
  "upstreams",
  "proxyProtocolVersion",
  "lbEnabled",
  "lbPolicy",
  "geoblockEnabled",
];

/** Prints what the form posted: the matcher and PROXY protocol choices are only visible there. */
export default function L4HostEditorDemo() {
  const [open, setOpen] = useState<"create" | "edit" | null>(null);
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
          <Button variant="secondary" label="Edit postgres" onClick={() => setOpen("edit")} />
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
      <CreateL4HostDialog open={open === "create"} onClose={() => setOpen(null)} agents={AGENTS} />
      {open === "edit" && (
        <EditL4HostDialog
          open
          host={POSTGRES}
          onClose={() => setOpen(null)}
          agents={AGENTS}
          assignedAgentIds={[]}
        />
      )}
    </DemoSurface>
  );
}
