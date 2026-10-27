"use client";

import type { ReactNode } from "react";
import { VStack } from "@astryxdesign/core/Stack";
import { HostPageTabs } from "@/components/host-history/HostPageTabs";
import {
  editorSectionHref,
  proxyHostDetailHref,
  proxyHostHistoryHref,
} from "@/lib/proxy-hosts/editor-sections";
import type { ProxyHostHeaderInfo } from "@/lib/proxy-hosts/header";
import { ProxyHostHeader } from "./ProxyHostHeader";

/** A host's Analytics or Logs tab: its header and tabs above the page it embeds. */
export function ProxyHostTabScreen({
  uuid,
  header,
  active,
  canManage,
  children,
}: {
  uuid: string;
  header: ProxyHostHeaderInfo;
  active: "analytics" | "logs";
  canManage: boolean;
  children: ReactNode;
}) {
  return (
    <VStack gap={5}>
      <ProxyHostHeader
        header={header}
        tabs={
          <HostPageTabs
            active={active}
            overviewHref={proxyHostDetailHref(uuid)}
            analyticsHref={header.analyticsHref}
            logsHref={header.logsHref}
            editHref={canManage ? editorSectionHref(uuid) : null}
            historyHref={canManage ? proxyHostHistoryHref(uuid) : null}
          />
        }
      />
      {children}
    </VStack>
  );
}
