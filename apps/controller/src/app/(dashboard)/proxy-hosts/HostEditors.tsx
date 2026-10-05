"use client";

/**
 * The list page's dialogs, loaded with their chunk on first open: the editor is most of the page's
 * code, and most visits to the list never open it. Create and edit wait for the pickers' options,
 * which the list no longer reads per navigation; an edit also waits for the host's forward-auth
 * grants, or saving would write an empty set over them.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ProxyHost } from "@/lib/models/proxy-hosts";
import type { EditorSection } from "@/lib/proxy-hosts/editor-sections";
import type { HostEditorOptions } from "@/lib/proxy-hosts/editor-options";
import type { AgentOption } from "@/components/agents/AgentAssignmentFields";
import {
  CreateHostDialog,
  DeleteHostDialog,
  EditHostDialog,
} from "@/components/proxy-hosts/HostDialogs";
import { WafPresetOptionsProvider } from "@/src/components/proxy-hosts/waf/WafPresetOptions";
import { hostForwardAuthAccessAction } from "./actions";

type ForwardAuthAccess = { userIds: number[]; groupIds: number[] };

/** Null until read; undefined for a host without CPM forward auth, which has none to read. */
function useForwardAuthAccess(
  host: ProxyHost | null,
  onFailed: () => void,
): ForwardAuthAccess | null | undefined {
  const needed = host?.cpmForwardAuth?.enabled ? host.id : null;
  const [loaded, setLoaded] = useState<{ id: number; access: ForwardAuthAccess } | null>(null);
  // The parent's close is new each render; the host is what the read depends on.
  const failed = useRef(onFailed);
  failed.current = onFailed;
  useEffect(() => {
    if (needed === null) return;
    let current = true;
    void hostForwardAuthAccessAction(needed).then((result) => {
      if (!current) return;
      if (result.ok) setLoaded({ id: needed, access: result.access });
      else {
        toast.error(result.message);
        failed.current();
      }
    });
    return () => {
      current = false;
    };
  }, [needed]);
  if (needed === null) return undefined;
  return loaded?.id === needed ? loaded.access : null;
}

export default function HostEditors({
  options,
  createOpen,
  createKey,
  duplicateHost,
  onCloseCreate,
  editHost,
  editSection,
  onCloseEdit,
  deleteHost,
  onCloseDelete,
  agents,
  agentAssignments,
  canEditRawConfig,
}: {
  /** Null while they are read; create and edit wait for them. */
  options: HostEditorOptions | null;
  createOpen: boolean;
  /** Remounts the create dialog on each open, resetting its form. */
  createKey: number;
  duplicateHost: ProxyHost | null;
  onCloseCreate: () => void;
  editHost: ProxyHost | null;
  editSection: EditorSection | null;
  onCloseEdit: () => void;
  deleteHost: ProxyHost | null;
  onCloseDelete: () => void;
  agents: AgentOption[];
  agentAssignments: Record<number, number[]>;
  canEditRawConfig: boolean;
}) {
  const forwardAuthAccess = useForwardAuthAccess(editHost, onCloseEdit);

  return (
    <>
      {options && (
        <WafPresetOptionsProvider presets={options.wafPresets} plugins={options.wafPlugins}>
          <CreateHostDialog
            defaultDomain={options.defaultDomain}
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

          {editHost && forwardAuthAccess !== null && (
            <EditHostDialog
              open
              host={editHost}
              initialSection={editSection}
              onClose={onCloseEdit}
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
              forwardAuthAccess={forwardAuthAccess ?? null}
              agents={agents}
              assignedAgentIds={agentAssignments[editHost.id] ?? []}
              canEditRawConfig={canEditRawConfig}
            />
          )}
        </WafPresetOptionsProvider>
      )}

      {deleteHost && <DeleteHostDialog open host={deleteHost} onClose={onCloseDelete} />}
    </>
  );
}
