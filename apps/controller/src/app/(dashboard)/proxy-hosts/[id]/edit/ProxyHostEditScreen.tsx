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
import { EditHostDialog } from "@/components/proxy-hosts/HostDialogs";
import { ProxyHostHeader } from "@/components/proxy-hosts/detail/ProxyHostHeader";
import { WafPresetOptionsProvider } from "@/components/proxy-hosts/waf/WafPresetOptions";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import type { HostEditorOptions } from "@/lib/proxy-hosts/editor-options";
import type { ProxyHostHeaderInfo } from "@/lib/proxy-hosts/header";
import {
  type EditorSection,
  editorSectionHref,
  editorSectionFromLink,
  isEditorSection,
  proxyHostDetailHref,
  proxyHostHistoryHref,
} from "@/lib/proxy-hosts/editor-sections";
import { proxyHostRollbackAction } from "../../actions";

/**
 * The edit route's whole page: the host's header and tabs, then its editor. It sits in the edit
 * layout, so a switch between sections, or the refresh after a save, keeps the form mounted.
 */
export function ProxyHostEditScreen({
  header,
  host: stored,
  options,
  forwardAuthAccess,
  agents,
  assignedAgentIds,
  canEditRawConfig,
  children,
}: {
  header: ProxyHostHeaderInfo;
  host: ProxyHost;
  options: HostEditorOptions;
  forwardAuthAccess: { userIds: number[]; groupIds: number[] } | null;
  agents: AgentOption[];
  assignedAgentIds: number[];
  canEditRawConfig: boolean;
  /** The section's page, which renders nothing of its own. */
  children: ReactNode;
}) {
  const t = useTranslations("hostHistory");
  const router = useRouter();
  const last = usePathname().split("/").at(-1);
  const [section, setSection] = useState<EditorSection>(isEditorSection(last) ? last : "general");
  // An old link put the section in the hash, which the server never sees.
  useEffect(() => {
    const hash = editorSectionFromLink(window.location.hash.slice(1));
    if (!hash) return;
    setSection(hash);
    const url = new URL(window.location.href);
    url.pathname = editorSectionHref(stored.uuid, hash);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }, [stored.uuid]);
  const rollback = useEditorRollback((revisionId) =>
    proxyHostRollbackAction(stored.id, revisionId),
  );

  return (
    <VStack gap={5}>
      <ProxyHostHeader
        header={header}
        tabs={
          <HostPageTabs
            active="edit"
            overviewHref={proxyHostDetailHref(stored.uuid)}
            editHref={editorSectionHref(stored.uuid)}
            historyHref={proxyHostHistoryHref(stored.uuid)}
          />
        }
      />
      {children}
      {rollback === undefined ? (
        <Spinner label={t("loadingRevision")} />
      ) : (
        <WafPresetOptionsProvider presets={options.wafPresets} plugins={options.wafPlugins}>
          <DynamicDnsProvidersProvider value={options.dynamicDnsProviders}>
            <EditHostDialog
              key={rollback?.notice.revisionId ?? "stored"}
              layout="page"
              open
              host={rollback?.host ?? stored}
              rollback={rollback?.notice ?? null}
              initialSection={section}
              sectionHref={(id) => editorSectionHref(stored.uuid, id as EditorSection)}
              // Saved: back to the host's page, which shows what changed.
              onClose={() => router.push(proxyHostDetailHref(stored.uuid))}
              certificates={options.certificates}
              accessLists={options.accessLists}
              authentikDefaults={options.authentikDefaults}
              forwardAuthDefaults={options.forwardAuthDefaults}
              tailscaleDefaults={options.tailscaleDefaults}
              caCertificates={options.caCertificates}
              mtlsRoles={options.mtlsRoles}
              issuedClientCerts={options.issuedClientCerts}
              forwardAuthUsers={options.forwardAuthUsers}
              forwardAuthGroups={options.forwardAuthGroups}
              forwardAuthAccess={forwardAuthAccess}
              agents={agents}
              assignedAgentIds={rollback?.agentIds ?? assignedAgentIds}
              canEditRawConfig={canEditRawConfig}
            />
          </DynamicDnsProvidersProvider>
        </WafPresetOptionsProvider>
      )}
    </VStack>
  );
}
