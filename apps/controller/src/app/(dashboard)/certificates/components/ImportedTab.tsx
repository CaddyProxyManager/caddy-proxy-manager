"use client";

import { AlertTriangle, FileKey, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { downloadText } from "@/src/lib/download-text";
import { toast } from "sonner";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { DataTable } from "@/components/ui/DataTable";
import { useEmptyValue } from "@/components/ui/empty-value";
import { deleteCertificateAction } from "../actions";
import type { CertExpiryStatus, ImportedCertView, ManagedCertView } from "../page";
import { RelativeTime } from "./RelativeTime";
import { ImportCertDrawer } from "./ImportCertDrawer";
import { useTranslations } from "next-intl";
import { Fab } from "@/src/components/mobile/Fab";

type Props = {
  importedCerts: ImportedCertView[];
  managedCerts: ManagedCertView[];
  search: string;
  statusFilter: string | null;
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

function ActionsMenu({ cert, onEdit }: { cert: ImportedCertView; onEdit: () => void }) {
  const t = useTranslations("certificates");
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

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      try {
        await deleteCertificateAction(cert.id);
        setDeleteOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("deleteFailed"));
      }
    });
  }

  return (
    <>
      <MoreMenu
        label={t("actionsForCertificate", { name: cert.name })}
        size="sm"
        alignment="end"
        items={[
          { label: t("edit"), onClick: onEdit },
          { label: t("downloadCertificate"), onClick: () => download(false) },
          { label: t("downloadKey"), onClick: () => download(true) },
          { type: "divider" },
          {
            label: t("delete"),
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

function importedMobileCard(c: ImportedCertView, onEdit: () => void) {
  return (
    <Card>
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
        <Text type="code" size="xsm" color="secondary">
          {c.domains.slice(0, 2).join(", ")}
          {c.domains.length > 2 ? ` +${c.domains.length - 2}` : ""}
        </Text>
        <RelativeTime validTo={c.validTo} status={c.expiryStatus} />
      </VStack>
    </Card>
  );
}

export function ImportedTab({ importedCerts, managedCerts, search, statusFilter }: Props) {
  const t = useTranslations("certificates");
  const emptyValue = useEmptyValue();
  const [drawerCert, setDrawerCert] = useState<ImportedCertView | null | false>(false);
  const mobileCardRenderer = (c: ImportedCertView) => importedMobileCard(c, () => setDrawerCert(c));

  const filtered = importedCerts.filter((c) => {
    if (statusFilter && c.expiryStatus !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return c.name.toLowerCase().includes(q) || c.domains.some((d) => d.toLowerCase().includes(q));
    }
    return true;
  });

  const columns = [
    {
      id: "name",
      label: t("name"),
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
      label: t("domains"),
      render: (c: ImportedCertView) => <DomainsCell domains={c.domains} />,
    },
    {
      id: "expiry",
      label: t("expires"),
      render: (c: ImportedCertView) => <RelativeTime validTo={c.validTo} status={c.expiryStatus} />,
    },
    {
      id: "usedBy",
      label: t("usedBy"),
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
      <HStack justify="end" className="cpm-desktop-only">
        <Button
          variant="primary"
          size="sm"
          label={t("importCertificate")}
          icon={<Plus />}
          onClick={() => setDrawerCert(null)}
        />
      </HStack>
      <Fab label={t("importCertificate")} onClick={() => setDrawerCert(null)} />

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
          <LegacyManagedTable managedCerts={managedCerts} />
        </VStack>
      )}

      <ImportCertDrawer
        open={drawerCert !== false}
        cert={drawerCert || null}
        onClose={() => setDrawerCert(false)}
      />
    </VStack>
  );
}

function LegacyManagedTable({ managedCerts }: { managedCerts: ManagedCertView[] }) {
  const t = useTranslations("certificates");
  const [isPending, startTransition] = useTransition();

  const columns = [
    {
      id: "name",
      label: t("name"),
      render: (c: ManagedCertView) => (
        <Text type="body" size="sm" weight="semibold">
          {c.name}
        </Text>
      ),
    },
    {
      id: "domains",
      label: t("domains"),
      render: (c: ManagedCertView) => (
        <Text type="code" size="sm" color="secondary">
          {c.domainNames.join(", ")}
        </Text>
      ),
    },
    {
      id: "actions",
      label: "",
      align: "right" as const,
      render: (c: ManagedCertView) => (
        <Button
          size="sm"
          variant="destructive"
          label={t("delete")}
          isDisabled={isPending}
          onClick={() =>
            startTransition(async () => {
              await deleteCertificateAction(c.id);
            })
          }
        />
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={managedCerts}
      keyField="id"
      emptyMessage={t("noLegacyManagedCertificates")}
    />
  );
}
