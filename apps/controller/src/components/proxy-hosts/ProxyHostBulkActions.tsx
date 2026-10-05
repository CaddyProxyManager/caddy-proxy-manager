"use client";

import { useState, useTransition } from "react";
import { Button } from "@astryxdesign/core/Button";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Selector } from "@astryxdesign/core/Selector";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { bulkProxyHostsAction } from "@/src/app/(dashboard)/proxy-hosts/actions";
import { BulkActionBar, BulkConfirmDialog } from "@/components/ui/BulkActionBar";
import type { AccessList } from "@/lib/models/access-lists";
import type { CertificatePickerOption } from "@/lib/certificates/api";
import type { ProxyHostBulkAction } from "@/lib/models/bulk-hosts";
import { NONE_VALUE, accessListOptions, accessListStatus, toOptions } from "./host-pickers";
import { BulkTagInput } from "./HostTagsField";

type Props = {
  hosts: { id: number; name: string }[];
  certificates: CertificatePickerOption[];
  accessLists: AccessList[];
  onClear: () => void;
};

const idOrNull = (value: string) => (value === NONE_VALUE ? null : Number(value));

/** The proxy host list's bar while rows are selected; every action confirms with the names. */
export function ProxyHostBulkActions({ hosts, certificates, accessLists, onClear }: Props) {
  const t = useTranslations("proxyHosts");
  const tb = useTranslations("ui.bulk");
  const tCommon = useTranslations("common");
  const [action, setAction] = useState<ProxyHostBulkAction | null>(null);
  const [certificateId, setCertificateId] = useState(NONE_VALUE);
  const [accessListId, setAccessListId] = useState(NONE_VALUE);
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function open(next: ProxyHostBulkAction) {
    setError(null);
    setAction(next);
  }

  function confirm() {
    if (!action) return;
    startTransition(async () => {
      const result = await bulkProxyHostsAction({
        action,
        ids: hosts.map((host) => host.id),
        ...(action === "setCertificate" ? { certificateId: idOrNull(certificateId) } : {}),
        ...(action === "setAccessList" ? { accessListId: idOrNull(accessListId) } : {}),
        ...(action === "addTag" ? { tag } : {}),
      });
      if (result.status === "error") {
        setError(result.message ?? null);
        return;
      }
      toast.success(result.message);
      setAction(null);
      onClear();
    });
  }

  const titles: Record<ProxyHostBulkAction, string> = {
    enable: tb("enableTitle"),
    disable: tb("disableTitle"),
    delete: tb("deleteTitle"),
    maintenanceOn: t("turnOnMaintenance"),
    maintenanceOff: t("turnOffMaintenance"),
    setCertificate: t("bulkSetCertificate"),
    setAccessList: t("bulkSetAccessList"),
    addTag: tb("addTagTitle"),
  };

  return (
    <>
      <BulkActionBar count={hosts.length} onClear={onClear}>
        <Button variant="ghost" label={tb("enable")} onClick={() => open("enable")} />
        <Button variant="ghost" label={tb("disable")} onClick={() => open("disable")} />
        <Button variant="ghost" label={tCommon("delete")} onClick={() => open("delete")} />
        <MoreMenu
          label={tb("moreActions")}
          size="sm"
          items={[
            { label: t("turnOnMaintenance"), onClick: () => open("maintenanceOn") },
            { label: t("turnOffMaintenance"), onClick: () => open("maintenanceOff") },
            { type: "divider" },
            { label: t("bulkSetCertificate"), onClick: () => open("setCertificate") },
            { label: t("bulkSetAccessList"), onClick: () => open("setAccessList") },
            { type: "divider" },
            { label: tb("addTag"), onClick: () => open("addTag") },
          ]}
        />
      </BulkActionBar>

      <BulkConfirmDialog
        open={action !== null}
        title={action ? titles[action] : ""}
        items={hosts}
        isDestructive={action === "delete"}
        confirmLabel={action === "delete" ? tCommon("delete") : undefined}
        isPending={isPending}
        error={error}
        onConfirm={confirm}
        onClose={() => setAction(null)}
      >
        {action === "setCertificate" && (
          <Selector
            label={t("certificate")}
            options={toOptions(certificates, t("managedByCaddyAuto"))}
            value={certificateId}
            onChange={(next) => setCertificateId(next as string)}
          />
        )}
        {action === "setAccessList" && (
          <Selector
            label={t("accessList")}
            options={accessListOptions(accessLists, t)}
            value={accessListId}
            onChange={(next) => setAccessListId(next as string)}
            status={accessListStatus(accessLists, accessListId, t)}
          />
        )}
        {action === "addTag" && <BulkTagInput value={tag} onChange={setTag} />}
      </BulkConfirmDialog>
    </>
  );
}
