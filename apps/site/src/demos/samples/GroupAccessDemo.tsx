import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  type GroupAccess,
  GroupAccessDialog,
  type NamedResource,
} from "@cpm/controller/src/components/groups/GroupAccessDialog";
import { DemoSurface } from "../DemoSurface";

const PROXY_HOSTS: NamedResource[] = [
  { id: 1, name: "grafana.example.com" },
  { id: 2, name: "git.example.com" },
  { id: 3, name: "nas.example.com" },
];
const L4_HOSTS: NamedResource[] = [{ id: 1, name: "postgres" }];
const AGENTS: NamedResource[] = [
  { id: 1, name: "bundled" },
  { id: 2, name: "edge-fra" },
];

function names(ids: number[], from: NamedResource[]): string {
  return from
    .filter((entry) => ids.includes(entry.id))
    .map((entry) => entry.name)
    .join(", ");
}

/** The app's dialog; saving hands the result back here instead of to the grant writes. */
export default function GroupAccessDemo() {
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<GroupAccess>({
    mappings: [{ providerId: "authentik", externalName: "platform-networking" }],
    proxyHostIds: [1],
    l4ProxyHostIds: [],
    agentIds: [],
    capability: "manage",
  });

  const granted = [
    names(access.proxyHostIds, PROXY_HOSTS),
    names(access.l4ProxyHostIds, L4_HOSTS),
    names(access.agentIds, AGENTS),
  ].filter(Boolean);

  return (
    <DemoSurface>
      <Card padding={4}>
        <VStack gap={2} align="start">
          <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
            <Text weight="semibold">Network team</Text>
            <Button variant="secondary" size="sm" label="Access" onClick={() => setOpen(true)} />
          </HStack>
          <Text size="sm" color="secondary">
            {access.mappings.length > 0
              ? `Filled from the IdP group ${access.mappings.map((m) => m.externalName).join(", ")}.`
              : "Members are added by hand."}
          </Text>
          <Text size="sm" color="secondary">
            {granted.length > 0
              ? `Operators in it can ${access.capability === "manage" ? "manage" : "view"} ${granted.join(", ")}.`
              : "It grants nothing, so an operator in it reaches nothing."}
          </Text>
        </VStack>
      </Card>
      {open && (
        <GroupAccessDialog
          open
          groupName="Network team"
          providers={[{ id: "authentik", name: "Authentik" }]}
          proxyHosts={PROXY_HOSTS}
          l4ProxyHosts={L4_HOSTS}
          agents={AGENTS}
          initial={access}
          onClose={() => setOpen(false)}
          onSave={(next) => {
            setAccess(next);
            setOpen(false);
          }}
        />
      )}
    </DemoSurface>
  );
}
