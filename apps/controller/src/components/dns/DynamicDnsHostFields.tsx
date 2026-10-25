"use client";

import { Globe } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import { useFeatureEnabled } from "@/components/caddy-modules/ModuleGate";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import type { DynamicDnsProviderOptions, HostDynamicDnsConfig } from "@/lib/dns/dynamic-dns";
import { Switch } from "@/src/components/ui/FormBooleanControls";

const NO_PROVIDERS: DynamicDnsProviderOptions = { choices: [], default: null };
const DynamicDnsProvidersContext = createContext<DynamicDnsProviderOptions>(NO_PROVIDERS);

/** Read when the editor opens, like the other pickers, so each field need not be handed it. */
export function DynamicDnsProvidersProvider({
  value,
  children,
}: {
  value: DynamicDnsProviderOptions;
  children: ReactNode;
}) {
  return (
    <DynamicDnsProvidersContext.Provider value={value}>
      {children}
    </DynamicDnsProvidersContext.Provider>
  );
}

/** The selector's value for "the default provider"; a provider name never takes this form. */
const DEFAULT_PROVIDER = "@default";

/**
 * A host's own dynamic DNS. `withHostnames` is for L4 hosts, which have no domains of their own;
 * a proxy host updates its domains. Fields stay in the form while off, so they are kept.
 */
export function DynamicDnsHostFields({
  dynamicDns,
  withHostnames = false,
}: {
  dynamicDns?: HostDynamicDnsConfig | null;
  withHostnames?: boolean;
}) {
  const t = useTranslations("dynamicDnsHost");
  const tSettings = useTranslations("settings.dynamicDns");
  const tCertificates = useTranslations("certificates");
  const providers = useContext(DynamicDnsProvidersContext);
  const moduleSelected = useFeatureEnabled("ddns");
  const [enabled, setEnabled] = useState(dynamicDns?.enabled ?? false);
  const [provider, setProvider] = useState(dynamicDns?.provider ?? DEFAULT_PROVIDER);
  const [zone, setZone] = useState(dynamicDns?.zone ?? "");
  const [hostnames, setHostnames] = useState((dynamicDns?.hostnames ?? []).join("\n"));

  const defaultName = providers.choices.find((p) => p.name === providers.default)?.displayName;
  const providerOptions = [
    {
      value: DEFAULT_PROVIDER,
      label: defaultName ? t("defaultProviderNamed", { name: defaultName }) : t("defaultProvider"),
      disabled: !defaultName,
    },
    // Brand names, so they stay as the registry spells them.
    ...providers.choices.map((choice) => ({ value: choice.name, label: choice.displayName })),
  ];

  return (
    <Card>
      <input type="hidden" name="dynamicDnsPresent" value="1" />
      <input
        type="hidden"
        name="dynamicDnsProvider"
        value={provider === DEFAULT_PROVIDER ? "" : provider}
      />
      {!enabled && (
        <>
          <input type="hidden" name="dynamicDnsZone" value={zone} />
          {withHostnames && <input type="hidden" name="dynamicDnsHostnames" value={hostnames} />}
        </>
      )}
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("title")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {withHostnames ? t("descriptionL4") : t("description")}
            </Text>
          </VStack>
          <Switch
            label={t("enable")}
            isLabelHidden
            htmlName="dynamicDnsEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>
        {enabled && providers.choices.length === 0 && (
          <Banner
            status="warning"
            title={tSettings("noProvidersTitle")}
            description={t("noProviders")}
          />
        )}
        {enabled && providers.choices.length > 0 && !moduleSelected && (
          <Banner status="info" title={t("moduleTitle")} description={t("module")} />
        )}
        {enabled && (
          <>
            {withHostnames && (
              <TextArea
                {...NO_SPELLCHECK}
                label={t("hostnames")}
                description={t("hostnamesHelp")}
                htmlName="dynamicDnsHostnames"
                rows={2}
                placeholder="game.example.com"
                value={hostnames}
                onChange={setHostnames}
                isRequired
              />
            )}
            <Grid columns={{ minWidth: 220, max: 2 }} gap={3}>
              <Selector
                label={tCertificates("dnsProvider")}
                description={tSettings("providerHelp")}
                size="sm"
                options={providerOptions}
                value={provider}
                onChange={setProvider}
              />
              <TextInput
                startIcon={Globe}
                {...NO_SPELLCHECK}
                label={tSettings("zone")}
                description={t("zoneHelp")}
                htmlName="dynamicDnsZone"
                size="sm"
                isOptional
                placeholder="example.com"
                value={zone}
                onChange={setZone}
              />
            </Grid>
          </>
        )}
      </VStack>
    </Card>
  );
}
