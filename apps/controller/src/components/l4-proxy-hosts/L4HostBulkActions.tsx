"use client";

import { useState, useTransition } from "react";
import { Button } from "@astryxdesign/core/Button";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { bulkL4ProxyHostsAction } from "@/src/app/(dashboard)/l4-proxy-hosts/actions";
import { BulkActionBar, BulkConfirmDialog } from "@/components/ui/BulkActionBar";
import type { L4HostBulkAction } from "@/lib/models/bulk-hosts";

/** The L4 list's bar while rows are selected. `onDone` also refreshes the ports banner. */
export function L4HostBulkActions({
  hosts,
  onClear,
  onDone,
}: {
  hosts: { id: number; name: string }[];
  onClear: () => void;
  onDone: () => void;
}) {
  const tb = useTranslations("ui.bulk");
  const [action, setAction] = useState<L4HostBulkAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function open(next: L4HostBulkAction) {
    setError(null);
    setAction(next);
  }

  function confirm() {
    if (!action) return;
    startTransition(async () => {
      const result = await bulkL4ProxyHostsAction({ action, ids: hosts.map((host) => host.id) });
      if (result.status === "error") {
        setError(result.message ?? null);
        return;
      }
      toast.success(result.message);
      setAction(null);
      onClear();
      onDone();
    });
  }

  const titles: Record<L4HostBulkAction, string> = {
    enable: tb("enableTitle"),
    disable: tb("disableTitle"),
    delete: tb("deleteTitle"),
  };

  return (
    <>
      <BulkActionBar count={hosts.length} onClear={onClear}>
        <Button variant="ghost" label={tb("enable")} onClick={() => open("enable")} />
        <Button variant="ghost" label={tb("disable")} onClick={() => open("disable")} />
        <Button variant="ghost" label={tb("delete")} onClick={() => open("delete")} />
      </BulkActionBar>
      <BulkConfirmDialog
        open={action !== null}
        title={action ? titles[action] : ""}
        items={hosts}
        isDestructive={action === "delete"}
        confirmLabel={action === "delete" ? tb("delete") : undefined}
        isPending={isPending}
        error={error}
        onConfirm={confirm}
        onClose={() => setAction(null)}
      />
    </>
  );
}
