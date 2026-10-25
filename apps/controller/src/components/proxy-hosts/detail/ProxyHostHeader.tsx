"use client";

import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { HostStatusCell } from "@/components/proxy-hosts/HostInsightCells";
import { HostTagList } from "@/components/proxy-hosts/HostTagsField";
import type { ProxyHostHeaderInfo } from "@/lib/proxy-hosts/header";

/** The same head on every one of a host's tabs, so switching tabs keeps the host in view. */
export function ProxyHostHeader({
  header,
  tabs,
}: {
  header: ProxyHostHeaderInfo;
  tabs: ReactNode;
}) {
  const tNav = useTranslations("nav");
  return (
    <VStack gap={2}>
      <HStack>
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft />}
          label={tNav("proxyHosts")}
          href="/proxy-hosts"
        />
      </HStack>
      <HStack justify="between" vAlign="center" gap={4} wrap="wrap">
        <VStack gap={1}>
          <HStack gap={3} vAlign="center" wrap="wrap">
            <Heading level={1}>{header.name}</Heading>
            <HostStatusCell status={header.status} />
          </HStack>
          <Text type="code" size="sm" color="secondary">
            {header.domains.join(", ")}
          </Text>
          <HostTagList tags={header.tags} />
        </VStack>
        <HStack gap={2} wrap="wrap">
          {header.analyticsHref && (
            <Button variant="secondary" label={tNav("analytics")} href={header.analyticsHref} />
          )}
          {header.logsHref && (
            <Button variant="secondary" label={tNav("logs")} href={header.logsHref} />
          )}
        </HStack>
      </HStack>
      {tabs}
    </VStack>
  );
}
