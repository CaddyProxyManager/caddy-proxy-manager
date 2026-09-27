"use client";

import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { useEmptyValue } from "@/components/ui/empty-value";
import {
  DeleteCaCertDialog,
  IssueClientCertDialog,
  ManageIssuedClientCertsDialog,
} from "@/components/ca-certificates/CaCertDialogs";
import type { CaCertificateView } from "../page";
import { CaCertDrawer } from "./CaCertDrawer";
import { useTranslations } from "next-intl";
import { Fab } from "@/src/components/mobile/Fab";

type Props = {
  caCertificates: CaCertificateView[];
  search: string;
  statusFilter: string | null;
};

function formatRelativeDate(t: ReturnType<typeof useTranslations<"certificates">>, iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return t("addedToday");
  if (days === 1) return t("addedYesterday");
  if (days < 30) return t("addedDaysAgo", { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t("addedMonthsAgo", { count: months });
  const years = Math.floor(months / 12);
  return t("addedYearsAgo", { count: years });
}

function IssuedCertsPanel({ ca }: { ca: CaCertificateView }) {
  const t = useTranslations("certificates");
  const [issueCaOpen, setIssueCaOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const active = ca.issuedCerts.filter((c) => !c.revokedAt);

  return (
    <VStack gap={3} padding={4}>
      <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
        <HStack gap={2} vAlign="center">
          <Text type="label" size="xsm" weight="semibold" color="secondary">
            {t("issuedClientCertificates")}
          </Text>
          <Badge variant="success" label={t("activeCount", { count: active.length })} />
        </HStack>
        <HStack gap={2}>
          {ca.hasPrivateKey && (
            <Button
              size="sm"
              variant="primary"
              label={t("issueCert")}
              onClick={() => setIssueCaOpen(true)}
            />
          )}
          {ca.issuedCerts.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              label={t("manage")}
              onClick={() => setManageOpen(true)}
            />
          )}
        </HStack>
      </HStack>

      {active.length === 0 ? (
        <Text type="body" size="sm" color="secondary">
          {t("clientCertificatesEmptyTitle")}
        </Text>
      ) : (
        <List hasDividers>
          {active.slice(0, 5).map((issued) => {
            const expired = new Date(issued.validTo).getTime() < Date.now();
            return (
              <ListItem
                key={issued.id}
                label={issued.commonName}
                endContent={
                  <Badge
                    variant={expired ? "error" : "success"}
                    label={expired ? t("expired") : t("active")}
                  />
                }
              />
            );
          })}
          {active.length > 5 && (
            <ListItem
              label={t("moreCount", { count: active.length - 5 })}
              description={t("useManageToViewAll")}
            />
          )}
        </List>
      )}

      <ManageIssuedClientCertsDialog
        open={manageOpen}
        cert={ca}
        issuedCerts={ca.issuedCerts}
        onClose={() => setManageOpen(false)}
      />
      <IssueClientCertDialog open={issueCaOpen} cert={ca} onClose={() => setIssueCaOpen(false)} />
    </VStack>
  );
}

function CaActionsMenu({
  ca,
  onEdit,
  onDelete,
}: {
  ca: CaCertificateView;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("certificates");
  const [issuedOpen, setIssuedOpen] = useState(false);

  return (
    <>
      <MoreMenu
        label={t("actionsForCaCertificate", { name: ca.name })}
        size="sm"
        alignment="end"
        items={[
          ...(ca.hasPrivateKey
            ? [{ label: t("issueClientCert"), onClick: () => setIssuedOpen(true) }]
            : []),
          { label: t("edit"), onClick: onEdit },
          { label: t("delete"), variant: "destructive" as const, onClick: onDelete },
        ]}
      />
      <IssueClientCertDialog open={issuedOpen} cert={ca} onClose={() => setIssuedOpen(false)} />
    </>
  );
}

function activeCount(ca: CaCertificateView) {
  return ca.issuedCerts.filter((c) => !c.revokedAt).length;
}

export function CaTab({ caCertificates, search, statusFilter }: Props) {
  const t = useTranslations("certificates");
  const emptyValue = useEmptyValue();
  const [drawerCert, setDrawerCert] = useState<CaCertificateView | null | false>(false);
  const [deleteCert, setDeleteCert] = useState<CaCertificateView | null>(null);

  const filtered = caCertificates.filter((ca) => {
    if (statusFilter) return false;
    if (search) return ca.name.toLowerCase().includes(search.toLowerCase());
    return true;
  });

  const columns: Column<CaCertificateView>[] = [
    {
      id: "name",
      label: t("name"),
      render: (ca) => (
        <HStack gap={3} vAlign="center">
          <Icon icon={ShieldCheck} size="sm" color="accent" />
          <Text type="body" size="sm" weight="semibold">
            {ca.name}
          </Text>
        </HStack>
      ),
    },
    {
      id: "privateKey",
      label: t("privateKey"),
      width: 140,
      render: (ca) =>
        ca.hasPrivateKey ? (
          <Badge variant="success" icon={<KeyRound />} label={t("stored")} />
        ) : (
          <Text type="body" size="sm" color="secondary">
            {emptyValue}
          </Text>
        ),
    },
    {
      id: "issued",
      label: t("issuedCerts"),
      width: 140,
      render: (ca) =>
        ca.issuedCerts.length === 0 ? (
          <Text type="body" size="sm" color="secondary">
            {t("none")}{" "}
          </Text>
        ) : (
          <Badge
            variant={activeCount(ca) > 0 ? "info" : "neutral"}
            label={t("activeOfTotal", { active: activeCount(ca), total: ca.issuedCerts.length })}
          />
        ),
    },
    {
      id: "added",
      label: t("added"),
      width: 120,
      render: (ca) => (
        <Text type="body" size="sm" color="secondary">
          {formatRelativeDate(t, ca.createdAt)}
        </Text>
      ),
    },
    {
      id: "actions",
      label: "",
      align: "right",
      width: 64,
      render: (ca) => (
        <CaActionsMenu
          ca={ca}
          onEdit={() => setDrawerCert(ca)}
          onDelete={() => setDeleteCert(ca)}
        />
      ),
    },
  ];

  function caMobileCard(ca: CaCertificateView) {
    return (
      <Card>
        <VStack gap={2}>
          <HStack justify="between" vAlign="center" gap={2}>
            <HStack gap={2} vAlign="center">
              <Icon icon={ShieldCheck} size="sm" color="accent" />
              <Text type="body" size="sm" weight="semibold">
                {ca.name}
              </Text>
            </HStack>
            <CaActionsMenu
              ca={ca}
              onEdit={() => setDrawerCert(ca)}
              onDelete={() => setDeleteCert(ca)}
            />
          </HStack>
          <HStack gap={2} wrap="wrap" vAlign="center">
            {ca.hasPrivateKey && (
              <Badge variant="success" icon={<KeyRound />} label={t("keyStored")} />
            )}
            {ca.issuedCerts.length > 0 && (
              <Badge
                variant={activeCount(ca) > 0 ? "info" : "neutral"}
                label={t("activeOfTotal", {
                  active: activeCount(ca),
                  total: ca.issuedCerts.length,
                })}
              />
            )}
            <Text type="body" size="xsm" color="secondary">
              {formatRelativeDate(t, ca.createdAt)}
            </Text>
          </HStack>
          {/* On mobile there is no row to expand into, so the panel follows the card. */}
          <IssuedCertsPanel ca={ca} />
        </VStack>
      </Card>
    );
  }

  return (
    <VStack gap={4}>
      <HStack justify="end" className="cpm-desktop-only">
        <Button
          variant="primary"
          size="sm"
          label={t("addCaCertificate")}
          icon={<Plus />}
          onClick={() => setDrawerCert(null)}
        />
      </HStack>
      <Fab label={t("addCaCertificate")} onClick={() => setDrawerCert(null)} />

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            title={
              search || statusFilter ? t("noCaCertificatesMatch") : t("noCaCertificatesConfigured")
            }
          />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={filtered}
          keyField="id"
          emptyMessage={t("noCaCertificatesMatch")}
          mobileCard={caMobileCard}
          expandedRow={(ca) => <IssuedCertsPanel ca={ca} />}
        />
      )}

      <CaCertDrawer
        open={drawerCert !== false}
        cert={drawerCert || null}
        onClose={() => setDrawerCert(false)}
      />
      {deleteCert && (
        <DeleteCaCertDialog
          open={!!deleteCert}
          cert={deleteCert}
          onClose={() => setDeleteCert(null)}
        />
      )}
    </VStack>
  );
}
