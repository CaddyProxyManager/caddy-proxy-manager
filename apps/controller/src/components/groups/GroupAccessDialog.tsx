"use client";

/**
 * Mapping and grants share a dialog: naming an IdP group is for handing it grants. Capability is
 * per section, not per row - the database allows it, but nobody asked for a dropdown per row.
 */

import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import { useTranslations } from "next-intl";

export type NamedResource = { id: number; name: string };
export type ProviderOption = { id: string; name: string };

export type GroupAccess = {
  mappings: { providerId: string | null; externalName: string }[];
  proxyHostIds: number[];
  l4ProxyHostIds: number[];
  agentIds: number[];
  capability: "view" | "manage";
};

const ANY_PROVIDER = "__any__";

export function GroupAccessDialog({
  open,
  groupName,
  providers,
  proxyHosts,
  l4ProxyHosts,
  agents,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  groupName: string;
  providers: ProviderOption[];
  proxyHosts: NamedResource[];
  l4ProxyHosts: NamedResource[];
  agents: NamedResource[];
  initial: GroupAccess;
  onClose: () => void;
  onSave: (access: GroupAccess) => void;
}) {
  const t = useTranslations("groups");

  // One provider for the whole list; nobody asked to mix them per row.
  const [providerId, setProviderId] = useState<string>(
    initial.mappings.find((m) => m.providerId)?.providerId ?? ANY_PROVIDER,
  );
  const [names, setNames] = useState(initial.mappings.map((m) => m.externalName).join("\n"));
  const [proxyHostIds, setProxyHostIds] = useState<number[]>(initial.proxyHostIds);
  const [l4Ids, setL4Ids] = useState<number[]>(initial.l4ProxyHostIds);
  const [agentIds, setAgentIds] = useState<number[]>(initial.agentIds);
  const [capability, setCapability] = useState<"view" | "manage">(initial.capability);

  function submit() {
    const resolved = providerId === ANY_PROVIDER ? null : providerId;
    onSave({
      mappings: names
        .split(/[\n,]/)
        .map((name) => name.trim())
        .filter(Boolean)
        .map((externalName) => ({ providerId: resolved, externalName })),
      proxyHostIds,
      l4ProxyHostIds: l4Ids,
      agentIds,
      capability,
    });
  }

  const nothingGranted = proxyHostIds.length === 0 && l4Ids.length === 0 && agentIds.length === 0;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("accessForGroup", { name: groupName })}
      maxWidth="lg"
      submitLabel={t("saveAccess")}
      onSubmit={submit}
    >
      <VStack gap={5}>
        <Card>
          <VStack gap={3}>
            <VStack gap={1}>
              <Text type="body" size="sm" weight="semibold">
                {t("idpMapping")}
              </Text>
              <Text type="body" size="sm" color="secondary">
                {t("idpMappingHelp")}
              </Text>
            </VStack>
            {providers.length > 0 && (
              <Selector
                label={t("idpProvider")}
                options={[
                  { value: ANY_PROVIDER, label: t("anyProvider") },
                  ...providers.map((p) => ({ value: p.id, label: p.name })),
                ]}
                value={providerId}
                onChange={(next) => setProviderId(next as string)}
              />
            )}
            <TextArea
              label={t("idpGroupNames")}
              value={names}
              onChange={setNames}
              rows={3}
              placeholder={"AD-Infra-Proxy-Admins\nplatform-networking"}
              description={t("idpGroupNamesHelp")}
            />
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <VStack gap={1}>
              <Text type="body" size="sm" weight="semibold">
                {t("grants")}
              </Text>
              <Text type="body" size="sm" color="secondary">
                {t("grantsHelp")}
              </Text>
            </VStack>

            <Selector
              label={t("capability")}
              description={t("capabilityHelp")}
              options={[
                { value: "manage", label: t("capabilityManage") },
                { value: "view", label: t("capabilityView") },
              ]}
              value={capability}
              onChange={(next) => setCapability(next as "view" | "manage")}
            />

            {proxyHosts.length > 0 && (
              <CheckboxList
                label={t("proxyHosts")}
                hasDividers
                value={proxyHostIds.map(String)}
                onChange={(values) => setProxyHostIds(values.map(Number))}
              >
                {proxyHosts.map((host) => (
                  <CheckboxListItem key={host.id} value={String(host.id)} label={host.name} />
                ))}
              </CheckboxList>
            )}

            {l4ProxyHosts.length > 0 && (
              <CheckboxList
                label={t("l4ProxyHosts")}
                hasDividers
                value={l4Ids.map(String)}
                onChange={(values) => setL4Ids(values.map(Number))}
              >
                {l4ProxyHosts.map((host) => (
                  <CheckboxListItem key={host.id} value={String(host.id)} label={host.name} />
                ))}
              </CheckboxList>
            )}

            {agents.length > 0 && (
              <CheckboxList
                label={t("agents")}
                hasDividers
                value={agentIds.map(String)}
                onChange={(values) => setAgentIds(values.map(Number))}
              >
                {agents.map((agent) => (
                  <CheckboxListItem key={agent.id} value={String(agent.id)} label={agent.name} />
                ))}
              </CheckboxList>
            )}

            {nothingGranted && (
              <Banner status="info" title={t("noGrants")} description={t("noGrantsHelp")} />
            )}
          </VStack>
        </Card>
      </VStack>
    </AppDialog>
  );
}
