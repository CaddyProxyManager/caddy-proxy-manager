"use client";

/**
 * The list page's dialogs, loaded with their chunk on first open: the editor is most of the page's
 * code, and most visits to the list never open it. Create waits for the pickers' options, which
 * the list no longer reads per navigation. Editing is the host's own page.
 */
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import type { HostEditorOptions } from "@/lib/proxy-hosts/editor-options";
import type { AgentOption } from "@/components/agents/AgentAssignmentFields";
import { CreateHostDialog, DeleteHostDialog } from "@/components/proxy-hosts/HostDialogs";
import { WafPresetOptionsProvider } from "@/src/components/proxy-hosts/waf/WafPresetOptions";
import { DynamicDnsProvidersProvider } from "@/src/components/dns/DynamicDnsHostFields";

export default function HostEditors({
  options,
  createOpen,
  createKey,
  duplicateHost,
  onCloseCreate,
  deleteHost,
  onCloseDelete,
  agents,
}: {
  /** Null while they are read; create waits for them. */
  options: HostEditorOptions | null;
  createOpen: boolean;
  /** Remounts the create dialog on each open, resetting its form. */
  createKey: number;
  duplicateHost: ProxyHost | null;
  onCloseCreate: () => void;
  deleteHost: ProxyHost | null;
  onCloseDelete: () => void;
  agents: AgentOption[];
}) {
  return (
    <>
      {options && (
        <WafPresetOptionsProvider presets={options.wafPresets} plugins={options.wafPlugins}>
          <DynamicDnsProvidersProvider value={options.dynamicDnsProviders}>
            <CreateHostDialog
              defaultDomain={options.defaultDomain}
              hostDefaults={options.hostDefaults}
              key={createKey}
              open={createOpen}
              onClose={onCloseCreate}
              initialData={duplicateHost}
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
              agents={agents}
            />
          </DynamicDnsProvidersProvider>
        </WafPresetOptionsProvider>
      )}

      {deleteHost && <DeleteHostDialog open host={deleteHost} onClose={onCloseDelete} />}
    </>
  );
}
