"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { CaddyCertificate } from "@cpm/shared";
import { ReachabilityDialog } from "@/components/certificates/ReachabilityDialog";
import { DataTable } from "@/components/ui/DataTable";
import { StatusChip } from "@/components/ui/StatusChip";
import { Timestamp } from "@/components/ui/Timestamp";
import { downloadText } from "@/src/lib/browser/download-text";
import type { AcmeHost } from "../page";
import { useTranslations } from "next-intl";

type Props = {
  acmeHosts: AcmeHost[];
  acmePagination: { total: number; page: number; perPage: number };
  search: string;
  statusFilter: string | null;
};

type Stored = CaddyCertificate & { agentId: string };
type Inventory = { certificates: Stored[]; renewing: Set<string>; unreadable: number };

/** Expiring within this is worth a warning; Caddy itself renews at a third of the lifetime left. */
const SOON_MS = 14 * 24 * 60 * 60 * 1000;

function domainSummary(r: AcmeHost) {
  return r.domains.length > 1 ? `${r.domains[0]} +${r.domains.length - 1}` : r.domains[0];
}

function acmeMobileCard(r: AcmeHost) {
  return (
    <Card>
      <VStack gap={2}>
        <Text type="body" size="sm" weight="semibold">
          {r.name}
        </Text>
        <Text type="code" size="sm" color="secondary">
          {domainSummary(r)}
        </Text>
        <StatusChip status={r.enabled ? "active" : "inactive"} />
      </VStack>
    </Card>
  );
}

/** The newest certificate in storage that covers a domain, on whichever agent has it. */
function certificateFor(domain: string, inventory: Inventory | null): Stored | null {
  const name = domain.toLowerCase();
  let best: Stored | null = null;
  for (const cert of inventory?.certificates ?? []) {
    if (!cert.names.some((n) => n.toLowerCase() === name)) continue;
    if (!best || cert.notAfter > best.notAfter) best = cert;
  }
  return best;
}

function useInventory() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/certificates/inventory");
      if (!response.ok) return;
      const body = (await response.json()) as {
        agents: { agentId: string; certificates: CaddyCertificate[] | null }[];
        renewing: string[];
      };
      setInventory({
        certificates: body.agents.flatMap((agent) =>
          (agent.certificates ?? []).map((cert) => ({ ...cert, agentId: agent.agentId })),
        ),
        renewing: new Set(body.renewing),
        unreadable: body.agents.filter((agent) => agent.certificates === null).length,
      });
    } catch {
      // The table still works without expiry dates.
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!inventory || inventory.renewing.size === 0) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [inventory, refresh]);
  return { inventory, refresh };
}

export function AcmeTab({ acmeHosts, acmePagination, search, statusFilter }: Props) {
  const t = useTranslations("certificates");
  const tCommon = useTranslations("common");
  const { inventory, refresh } = useInventory();
  const [checking, setChecking] = useState<AcmeHost | null>(null);

  const filtered = acmeHosts.filter((h) => {
    if (statusFilter && statusFilter !== "ok") return false;
    if (statusFilter === "ok" && !h.enabled) return false;
    if (search) {
      const q = search.toLowerCase();
      return h.name.toLowerCase().includes(q) || h.domains.some((d) => d.toLowerCase().includes(q));
    }
    return true;
  });

  const pagination =
    search || statusFilter
      ? { total: filtered.length, page: 1, perPage: filtered.length || 1 }
      : acmePagination;

  // The soonest expiry across a host's domains is the one that matters.
  const soonest = useMemo(() => {
    const byHost = new Map<number, Stored | null>();
    for (const host of acmeHosts) {
      const certs = host.domains.map((d) => certificateFor(d, inventory));
      byHost.set(
        host.id,
        certs.some((c) => !c)
          ? null
          : (certs as Stored[]).reduce(
              (a, b) => (a.notAfter < b.notAfter ? a : b),
              certs[0] as Stored,
            ),
      );
    }
    return byHost;
  }, [acmeHosts, inventory]);

  const renew = async (host: AcmeHost) => {
    const response = await fetch("/api/certificates/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: host.domains.filter((d) => !d.startsWith("*.")) }),
    });
    if (!response.ok) {
      toast.error(((await response.json()) as { error?: string }).error ?? t("renewFailed"));
      return;
    }
    toast.success(t("renewRequested"));
    refresh();
  };

  const download = async (cert: Stored, includeKey: boolean) => {
    const params = new URLSearchParams({
      agent: cert.agentId,
      issuer: cert.issuerKey,
      name: cert.name,
      ...(includeKey && { key: "1" }),
    });
    const response = await fetch(`/api/certificates/stored?${params}`);
    const body = (await response.json()) as {
      certificatePem?: string;
      keyPem?: string;
      error?: string;
    };
    if (!response.ok) {
      toast.error(body.error ?? t("downloadFailed"));
      return;
    }
    if (includeKey && body.keyPem) downloadText(`${cert.name}.key`, `${body.keyPem}\n`);
    else if (body.certificatePem) downloadText(`${cert.name}.crt`, `${body.certificatePem}\n`);
  };

  const columns = [
    {
      id: "name",
      label: t("proxyHost"),
      render: (r: AcmeHost) => (
        <HStack gap={3} vAlign="center">
          <Icon icon={Lock} size="sm" color={r.enabled ? "success" : "disabled"} />
          <VStack gap={0} className="cpm-cell-lines">
            <Text type="body" size="sm" weight="semibold">
              {r.name}
            </Text>
            <Tooltip content={r.domains.join(", ")}>
              <Text type="code" size="sm" color="secondary" maxLines={1}>
                {domainSummary(r)}
              </Text>
            </Tooltip>
          </VStack>
        </HStack>
      ),
    },
    {
      id: "expires",
      label: t("expires"),
      render: (r: AcmeHost) => {
        if (inventory?.renewing && r.domains.some((d) => inventory.renewing.has(d.toLowerCase()))) {
          return <Text size="sm">{t("renewing")}</Text>;
        }
        const cert = soonest.get(r.id);
        if (!inventory)
          return (
            <Text size="sm" color="secondary">
              …
            </Text>
          );
        if (!cert)
          return (
            <Text size="sm" color="secondary">
              {t("notIssuedYet")}
            </Text>
          );
        const left = Date.parse(cert.notAfter) - Date.now();
        const state = left < 0 ? "expired" : left < SOON_MS ? "soon" : "ok";
        return (
          <Tooltip content={t("issuedBy", { issuer: cert.issuer })}>
            <HStack gap={2} vAlign="center">
              <StatusDot
                variant={state === "expired" ? "error" : state === "soon" ? "warning" : "success"}
                label={t(`expiry.${state}`)}
              />
              <Text size="sm">
                <Timestamp value={cert.notAfter} style="date" />
              </Text>
            </HStack>
          </Tooltip>
        );
      },
    },
    {
      id: "status",
      label: tCommon("status"),
      width: 110,
      render: (r: AcmeHost) => <StatusChip status={r.enabled ? "active" : "inactive"} />,
    },
    {
      id: "actions",
      label: tCommon("actions"),
      width: 60,
      render: (r: AcmeHost) => {
        const cert = soonest.get(r.id) ?? null;
        return (
          <MoreMenu
            label={tCommon("actionsFor", { name: r.name })}
            size="sm"
            alignment="end"
            items={[
              { label: t("renew"), onClick: () => renew(r) },
              { label: tCommon("testReachability"), onClick: () => setChecking(r) },
              ...(cert
                ? [
                    { type: "divider" as const },
                    { label: t("downloadCertificate"), onClick: () => download(cert, false) },
                    { label: t("downloadKey"), onClick: () => download(cert, true) },
                  ]
                : []),
            ]}
          />
        );
      },
    },
  ];

  return (
    <VStack gap={3}>
      {inventory && inventory.unreadable > 0 && (
        <Text type="supporting">{t("inventoryPartial", { count: inventory.unreadable })}</Text>
      )}
      <DataTable
        columns={columns}
        data={filtered}
        keyField="id"
        emptyMessage={t("noAcmeCertificatesMatch")}
        pagination={pagination}
        mobileCard={acmeMobileCard}
        rowStatus={(r) => (r.enabled ? null : { color: "gray", label: t("disabled") })}
      />
      {checking && (
        <ReachabilityDialog
          open
          hostId={checking.id}
          hostName={checking.name}
          onClose={() => setChecking(null)}
        />
      )}
    </VStack>
  );
}
