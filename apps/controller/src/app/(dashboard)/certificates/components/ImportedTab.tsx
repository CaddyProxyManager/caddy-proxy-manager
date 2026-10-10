"use client";

import { AlertTriangle, FileKey, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { ACCENTS } from "@/components/ui/accent";
import { Icon } from "@astryxdesign/core/Icon";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { downloadText } from "@/src/lib/browser/download-text";
import { toast } from "sonner";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { DataTable } from "@/components/ui/DataTable";
import { useEmptyValue } from "@/components/ui/empty-value";
import {
  deleteCertificateAction,
  deleteUnusedCertificatesAction,
  rereadCertificateFileAction,
} from "../actions";
import { Timestamp } from "@/components/ui/Timestamp";
import { certificateFileErrorMessage } from "@/src/lib/certificates/file-errors";
import { BulkConfirmDialog } from "@/components/ui/BulkActionBar";
import type {
  CertExpiryStatus,
  CertificateFileAgent,
  DnsProviderChoice,
  ImportedCertView,
  ManagedCertView,
} from "../page";
import { RelativeTime } from "./RelativeTime";
import { ImportCertDrawer } from "./ImportCertDrawer";
import { useTranslations } from "next-intl";
import { Fab } from "@/src/components/mobile/Fab";

type Props = {
  importedCerts: ImportedCertView[];
  managedCerts: ManagedCertView[];
  search: string;
  statusFilter: string | null;
  fileAgents: CertificateFileAgent[];
  dnsProviders: DnsProviderChoice[];
};

/** Icon tint tracks expiry, matching the badge shown in the Expires column. */
function expiryIconColor(status: CertExpiryStatus | null) {
  if (status === "expired") return "error" as const;
  if (status === "expiring_soon") return "warning" as const;
  return "success" as const;
}

function DomainsCell({ domains }: { domains: string[] }) {
  const visible = domains.slice(0, 2);
  const rest = domains.slice(2);
  return (
    <HStack gap={1} wrap="wrap">
      {visible.map((d) => (
        <Badge key={d} variant="info" label={d} />
      ))}
      {rest.length > 0 && (
        <Tooltip content={rest.join(", ")}>
          <Badge label={`+${rest.length}`} />
        </Tooltip>
      )}
    </HStack>
  );
}

/** Where a file certificate comes from, when it was last read, and why the last read failed. */
function SourceCell({ cert }: { cert: ImportedCertView }) {
  const t = useTranslations("certificates");
  const tErrors = useTranslations("errors");
  const emptyValue = useEmptyValue();
  const file = cert.file;
  if (!file) {
    return (
      <Text type="body" size="sm" color="secondary">
        {emptyValue}
      </Text>
    );
  }
  return (
    <VStack gap={1}>
      <Badge
        variant="info"
        label={
          file.agentName ? t("sourceAgentBadge", { agent: file.agentName }) : t("sourceAgentGone")
        }
      />
      <Text type="body" size="sm" color="secondary">
        {file.readAt
          ? t.rich("sourceReadAt", { time: () => <Timestamp value={file.readAt!} /> })
          : t("sourceNeverRead")}
      </Text>
      {file.error && (
        <HStack gap={1} vAlign="center">
          <Icon icon={AlertTriangle} size="sm" color="warning" />
          <Text type="body" size="sm" color="secondary">
            {tErrors(certificateFileErrorMessage(file.error))}
          </Text>
        </HStack>
      )}
    </VStack>
  );
}

function ActionsMenu({ cert, onEdit }: { cert: ImportedCertView; onEdit: () => void }) {
  const t = useTranslations("certificates");
  const tCommon = useTranslations("common");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function download(includeKey: boolean) {
    const response = await fetch(
      `/api/certificates/${cert.id}/download${includeKey ? "?key=1" : ""}`,
    );
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
  }

  function reread() {
    startTransition(async () => {
      const result = await rereadCertificateFileAction(cert.id);
      if (result.ok) toast.success(t("rereadDone"));
      else toast.error(result.error);
    });
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteCertificateAction(cert.id);
      if (result.ok) setDeleteOpen(false);
      else setError(result.error);
    });
  }

  return (
    <>
      <MoreMenu
        label={t("actionsForCertificate", { name: cert.name })}
        size="sm"
        alignment="end"
        items={[
          { label: tCommon("edit"), onClick: onEdit },
          ...(cert.file ? [{ label: t("reread"), onClick: reread }] : []),
          { label: t("downloadCertificate"), onClick: () => download(false) },
          { label: t("downloadKey"), onClick: () => download(true) },
          { type: "divider" },
          {
            label: tCommon("delete"),
            variant: "destructive",
            onClick: () => {
              setError(null);
              setDeleteOpen(true);
            },
          },
        ]}
      />

      {/* AlertDialog has no body slot, so a failed delete is appended to the
          description, which is what aria-describedby announces. */}
      <AlertDialog
        isOpen={deleteOpen}
        onOpenChange={(open) => {
          if (isPending) return;
          setDeleteOpen(open);
          if (!open) setError(null);
        }}
        title={t("deleteImportedCertificate")}
        description={
          error
            ? t("deleteImportedCertificateConfirmWithError", { name: cert.name, error })
            : t("deleteImportedCertificateConfirm", { name: cert.name })
        }
        actionLabel={t("deleteCertificate")}
        onAction={handleDelete}
        isActionLoading={isPending}
      />
    </>
  );
}

const EXPIRY_HUE = { error: "red", warning: "yellow", success: "green" } as const;

function importedMobileCard(c: ImportedCertView, onEdit: () => void) {
  return (
    <Card className={ACCENTS[EXPIRY_HUE[expiryIconColor(c.expiryStatus)]].edge}>
      <VStack gap={2}>
        <HStack justify="between" vAlign="center" gap={2}>
          <HStack gap={2} vAlign="center">
            <Icon icon={FileKey} size="sm" color={expiryIconColor(c.expiryStatus)} />
            <Text type="body" size="sm" weight="semibold">
              {c.name}
            </Text>
          </HStack>
          <ActionsMenu cert={c} onEdit={onEdit} />
        </HStack>
        <Text type="code" size="sm" color="secondary">
          {c.domains.slice(0, 2).join(", ")}
          {c.domains.length > 2 ? ` +${c.domains.length - 2}` : ""}
        </Text>
        <RelativeTime validTo={c.validTo} status={c.expiryStatus} />
        {c.file && <SourceCell cert={c} />}
      </VStack>
    </Card>
  );
}

export function ImportedTab({
  importedCerts,
  managedCerts,
  search,
  statusFilter,
  fileAgents,
  dnsProviders,
}: Props) {
  const t = useTranslations("certificates");
  const tCommon = useTranslations("common");
  const emptyValue = useEmptyValue();
  const [drawerCert, setDrawerCert] = useState<ImportedCertView | ManagedCertView | null | false>(
    false,
  );
  const mobileCardRenderer = (c: ImportedCertView) => importedMobileCard(c, () => setDrawerCert(c));

  const filtered = importedCerts.filter((c) => {
    if (statusFilter && c.expiryStatus !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return c.name.toLowerCase().includes(q) || c.domains.some((d) => d.toLowerCase().includes(q));
    }
    return true;
  });
  // What the table shows: a search that hides a certificate also keeps it out of the batch.
  const unused = filtered.filter((c) => c.usedBy.length === 0);
  const [unusedOpen, setUnusedOpen] = useState(false);
  const [unusedError, setUnusedError] = useState<string | null>(null);
  const [isDeletingUnused, startDeletingUnused] = useTransition();

  function deleteUnused() {
    setUnusedError(null);
    startDeletingUnused(async () => {
      const result = await deleteUnusedCertificatesAction(unused.map((c) => c.id));
      if (!result.ok) {
        setUnusedError(result.error);
        return;
      }
      toast.success(result.data);
      setUnusedOpen(false);
    });
  }

  const columns = [
    {
      id: "name",
      label: tCommon("name"),
      render: (c: ImportedCertView) => (
        <HStack gap={3} vAlign="center">
          <Icon icon={FileKey} size="sm" color={expiryIconColor(c.expiryStatus)} />
          <Text type="body" size="sm" weight="semibold">
            {c.name}
          </Text>
        </HStack>
      ),
    },
    {
      id: "domains",
      label: tCommon("domains"),
      render: (c: ImportedCertView) => <DomainsCell domains={c.domains} />,
    },
    {
      id: "source",
      label: t("sourceLabel"),
      render: (c: ImportedCertView) => <SourceCell cert={c} />,
    },
    {
      id: "expiry",
      label: t("expires"),
      render: (c: ImportedCertView) => <RelativeTime validTo={c.validTo} status={c.expiryStatus} />,
    },
    {
      id: "usedBy",
      label: tCommon("usedBy"),
      render: (c: ImportedCertView) =>
        c.usedBy.length === 0 ? (
          <Text type="body" size="sm" color="secondary">
            {emptyValue}
          </Text>
        ) : (
          <HStack gap={1} wrap="wrap">
            {c.usedBy.map((h) => (
              <Badge key={h.id} label={h.name} />
            ))}
          </HStack>
        ),
    },
    {
      id: "actions",
      label: "",
      align: "right" as const,
      render: (c: ImportedCertView) => <ActionsMenu cert={c} onEdit={() => setDrawerCert(c)} />,
    },
  ];

  return (
    <VStack gap={4}>
      <HStack justify="end" gap={2} className="cpm-desktop-only">
        {unused.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            label={t("deleteUnused")}
            onClick={() => {
              setUnusedError(null);
              setUnusedOpen(true);
            }}
          />
        )}
        <Button
          variant="primary"
          size="sm"
          label={tCommon("import")}
          icon={<Plus />}
          onClick={() => setDrawerCert(null)}
        />
      </HStack>
      <Fab label={tCommon("import")} onClick={() => setDrawerCert(null)} />

      <DataTable
        columns={columns}
        data={filtered}
        keyField="id"
        emptyMessage={t("noImportedCertificatesMatch")}
        mobileCard={mobileCardRenderer}
        rowStatus={(c) =>
          c.expiryStatus === "expired"
            ? { color: "error", icon: "error", label: t("expired") }
            : c.expiryStatus === "expiring_soon"
              ? { color: "warning", icon: "warning", label: t("expiringSoon") }
              : c.file?.error
                ? { color: "warning", icon: "warning", label: t("sourceReadFailed") }
                : null
        }
      />

      {managedCerts.length > 0 && (
        <VStack gap={2}>
          <Banner
            status="warning"
            icon={<AlertTriangle />}
            title={t("legacyCertificatesTitle")}
            description={t("legacyCertificatesDescription")}
          />
          <LegacyManagedTable
            managedCerts={managedCerts}
            dnsProviders={dnsProviders}
            onEdit={setDrawerCert}
          />
        </VStack>
      )}

      <BulkConfirmDialog
        open={unusedOpen}
        title={t("deleteUnusedTitle")}
        items={unused}
        summary={t("deleteUnusedSummary", { count: unused.length })}
        isDestructive
        confirmLabel={tCommon("delete")}
        isPending={isDeletingUnused}
        error={unusedError}
        onConfirm={deleteUnused}
        onClose={() => setUnusedOpen(false)}
      />

      <ImportCertDrawer
        open={drawerCert !== false}
        cert={drawerCert || null}
        fileAgents={fileAgents}
        dnsProviders={dnsProviders}
        onClose={() => setDrawerCert(false)}
      />
    </VStack>
  );
}

function LegacyManagedTable({
  managedCerts,
  dnsProviders,
  onEdit,
}: {
  managedCerts: ManagedCertView[];
  dnsProviders: DnsProviderChoice[];
  onEdit: (cert: ManagedCertView) => void;
}) {
  const t = useTranslations("certificates");
  const tCommon = useTranslations("common");
  const emptyValue = useEmptyValue();
  const [isPending, startTransition] = useTransition();
  const providerName = (name: string) =>
    dnsProviders.find((provider) => provider.name === name)?.displayName ?? name;

  const columns = [
    {
      id: "name",
      label: tCommon("name"),
      render: (c: ManagedCertView) => (
        <Text type="body" size="sm" weight="semibold">
          {c.name}
        </Text>
      ),
    },
    {
      id: "domains",
      label: tCommon("domains"),
      render: (c: ManagedCertView) => (
        <Text type="code" size="sm" color="secondary">
          {c.domains.join(", ")}
        </Text>
      ),
    },
    {
      id: "dnsProvider",
      label: t("dnsProvider"),
      render: (c: ManagedCertView) =>
        c.dnsProvider ? (
          <Badge variant="info" label={providerName(c.dnsProvider)} />
        ) : (
          <Text type="body" size="sm" color="secondary">
            {emptyValue}
          </Text>
        ),
    },
    {
      id: "actions",
      label: "",
      align: "right" as const,
      render: (c: ManagedCertView) => (
        <MoreMenu
          label={t("actionsForCertificate", { name: c.name })}
          size="sm"
          alignment="end"
          items={[
            { label: tCommon("edit"), onClick: () => onEdit(c) },
            { type: "divider" },
            {
              label: tCommon("delete"),
              variant: "destructive",
              isDisabled: isPending,
              onClick: () =>
                startTransition(async () => {
                  const result = await deleteCertificateAction(c.id);
                  if (!result.ok) toast.error(result.error);
                }),
            },
          ]}
        />
      ),
    },
  ];

  return (
    // The table bleeds out of its container by the container's padding, so it needs a card's.
    <Card>
      <DataTable
        columns={columns}
        data={managedCerts}
        keyField="id"
        emptyMessage={t("noLegacyManagedCertificates")}
      />
    </Card>
  );
}
