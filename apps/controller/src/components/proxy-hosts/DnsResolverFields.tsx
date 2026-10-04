"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import { Switch } from "@/src/components/ui/FormBooleanControls";
import { useTranslations } from "next-intl";

export function DnsResolverFields({
  dnsResolver,
}: {
  dnsResolver?: ProxyHost["dnsResolver"] | null;
}) {
  const t = useTranslations("proxyHosts");
  const initial = dnsResolver ?? null;
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [resolvers, setResolvers] = useState(initial?.resolvers?.join("\n") ?? "");
  const [fallbacks, setFallbacks] = useState(initial?.fallbacks?.join("\n") ?? "");
  const [timeout, setTimeout] = useState(initial?.timeout ?? "");

  return (
    <Card>
      <input type="hidden" name="dnsPresent" value="1" />
      <input type="hidden" name="dnsEnabledPresent" value="1" />

      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={4}>
          <VStack gap={1}>
            <Text type="body" size="sm" weight="semibold">
              {t("customDnsResolvers")}
            </Text>
            <Text type="body" size="sm" color="secondary">
              {t("dnsResolversDescription")}
            </Text>
          </VStack>
          <Switch
            label={t("enableCustomDnsResolvers")}
            isLabelHidden
            htmlName="dnsEnabled"
            value={enabled}
            onChange={setEnabled}
          />
        </HStack>

        {/* Unmounted, so hidden fields are neither focusable nor submitted. */}
        {enabled && (
          <VStack gap={5}>
            <TextArea
              label={t("dnsResolvers")}
              htmlName="dnsResolvers"
              placeholder={"1.1.1.1\n9.9.9.9"}
              value={resolvers}
              onChange={setResolvers}
              rows={2}
              description={t("dnsResolversHelp")}
            />
            <TextArea
              label={t("fallbackDnsResolvers")}
              isOptional
              htmlName="dnsFallbacks"
              placeholder={"1.0.0.1\n149.112.112.112"}
              value={fallbacks}
              onChange={setFallbacks}
              rows={2}
              description={t("fallbackResolversHelp")}
            />
            <TextInput
              startIcon={Clock}
              label={t("dnsConnectTimeout")}
              htmlName="dnsTimeout"
              placeholder="5s"
              value={timeout}
              onChange={setTimeout}
              description={t("dnsConnectTimeoutHelp")}
            />
            <Banner
              status="info"
              title={t("dnsResolverOverrideTitle")}
              description={t("dnsResolverOverrideDescription")}
            />
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
