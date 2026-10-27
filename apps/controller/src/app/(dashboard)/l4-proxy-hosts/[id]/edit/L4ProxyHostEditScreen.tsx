"use client";

import { type ReactNode, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import type { AgentOption } from "@/components/agents/AgentAssignmentFields";
import { DynamicDnsProvidersProvider } from "@/components/dns/DynamicDnsHostFields";
import { HostPageTabs } from "@/components/host-history/HostPageTabs";
import { useEditorRollback } from "@/components/host-history/useEditorRollback";
import { EditL4HostDialog } from "@/components/l4-proxy-hosts/L4HostDialogs";
import { ProxyHostHeader } from "@/components/proxy-hosts/detail/ProxyHostHeader";
import type { DynamicDnsProviderOptions } from "@/lib/dns/dynamic-dns";
import { l4HostHeader } from "@/lib/l4/detail-types";
import {
  type L4EditorSection,
  l4EditorSectionFromLink,
  isL4EditorSection,
  l4EditorSectionHref,
  l4ProxyHostDetailHref,
  l4ProxyHostHistoryHref,
} from "@/lib/l4/editor-sections";
import type { L4AccessListOption } from "@/lib/models/access-lists";
import type { L4ProxyHost } from "@/lib/models/l4-proxy-hosts";
import { l4ProxyHostRollbackAction } from "../../actions";

/** The edit route's whole page, held by the edit layout as the proxy host's is. */
export function L4ProxyHostEditScreen({
  host: stored,
  agents,
  accessLists,
  dynamicDnsProviders,
  assignedAgentIds,
  children,
}: {
  host: L4ProxyHost;
  agents: AgentOption[];
  accessLists: L4AccessListOption[];
  dynamicDnsProviders: DynamicDnsProviderOptions;
  assignedAgentIds: number[];
  /** The section's page, which renders nothing of its own. */
  children: ReactNode;
}) {
  const t = useTranslations("hostHistory");
  const router = useRouter();
  const last = usePathname().split("/").at(-1);
  const [section, setSection] = useState<L4EditorSection>(
    isL4EditorSection(last) ? last : "general",
  );
  // An old link put the section in the hash, which the server never sees.
  useEffect(() => {
    const hash = l4EditorSectionFromLink(window.location.hash.slice(1));
    if (!hash) return;
    setSection(hash);
    const url = new URL(window.location.href);
    url.pathname = l4EditorSectionHref(stored.uuid, hash);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }, [stored.uuid]);
  const rollback = useEditorRollback((revisionId) =>
    l4ProxyHostRollbackAction(stored.id, revisionId),
  );

  return (
    <VStack gap={5}>
      <ProxyHostHeader
        layer4
        header={l4HostHeader(stored)}
        tabs={
          <HostPageTabs
            active="edit"
            overviewHref={l4ProxyHostDetailHref(stored.uuid)}
            editHref={l4EditorSectionHref(stored.uuid)}
            historyHref={l4ProxyHostHistoryHref(stored.uuid)}
          />
        }
      />
      {children}
      {rollback === undefined ? (
        <Spinner label={t("loadingRevision")} />
      ) : (
        <DynamicDnsProvidersProvider value={dynamicDnsProviders}>
          <EditL4HostDialog
            key={rollback?.notice.revisionId ?? "stored"}
            layout="page"
            open
            host={rollback?.host ?? stored}
            rollback={rollback?.notice ?? null}
            initialSection={section}
            sectionHref={(id) => l4EditorSectionHref(stored.uuid, id as L4EditorSection)}
            // Saved: back to the list, whose banner says whether the ports need applying.
            onClose={() => router.push("/l4-proxy-hosts")}
            agents={agents}
            accessLists={accessLists}
            assignedAgentIds={rollback?.agentIds ?? assignedAgentIds}
          />
        </DynamicDnsProvidersProvider>
      )}
    </VStack>
  );
}
