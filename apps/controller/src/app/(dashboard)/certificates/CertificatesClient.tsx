"use client";

import { useState } from "react";
import { useTabRoute } from "@/components/ui/useTabRoute";
import { Badge } from "@astryxdesign/core/Badge";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { VStack } from "@astryxdesign/core/Stack";
import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { SearchField } from "@/components/ui/SearchField";
import { StatTiles } from "@/components/ui/StatTiles";
import type {
  AcmeHost,
  CaCertificateView,
  CertificateFileAgent,
  CertExpiryStatus,
  DnsProviderChoice,
  ImportedCertView,
  ManagedCertView,
  MtlsRole,
} from "./page";
import type { IssuedClientCertificate } from "@/lib/models/issued-client-certificates";
import { StatusSummaryBar } from "./components/StatusSummaryBar";
import { AcmeTab } from "./components/AcmeTab";
import { ImportedTab } from "./components/ImportedTab";
import { CaTab } from "./components/CaTab";
import { MtlsRolesTab } from "@/components/mtls-roles/MtlsRolesTab";
import { countExpiry } from "./certificate-summary";
import { useTranslations } from "next-intl";

const CERTIFICATE_TABS = ["acme", "imported", "ca", "roles"] as const;
type TabId = (typeof CERTIFICATE_TABS)[number];

type Props = {
  acmeHosts: AcmeHost[];
  importedCerts: ImportedCertView[];
  managedCerts: ManagedCertView[];
  caCertificates: CaCertificateView[];
  acmePagination: { total: number; page: number; perPage: number };
  healthyAcmeTotal: number;
  mtlsRoles: MtlsRole[];
  issuedClientCerts: IssuedClientCertificate[];
  fileAgents: CertificateFileAgent[];
  dnsProviders: DnsProviderChoice[];
};

export default function CertificatesClient({
  acmeHosts,
  importedCerts,
  managedCerts,
  caCertificates,
  acmePagination,
  healthyAcmeTotal,
  mtlsRoles,
  issuedClientCerts,
  fileAgents,
  dnsProviders,
}: Props) {
  const t = useTranslations("certificates");
  const [activeTab, setActiveTab] = useTabRoute("/certificates", CERTIFICATE_TABS, "acme");
  const [searchAcme, setSearchAcme] = useState("");
  const [searchImported, setSearchImported] = useState("");
  const [searchCa, setSearchCa] = useState("");
  const [searchRoles, setSearchRoles] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const importedStatuses: (CertExpiryStatus | null)[] = importedCerts.map((c) => c.expiryStatus);
  const { expired, expiringSoon, healthy: importedHealthy } = countExpiry(importedStatuses);
  const healthy = importedHealthy + healthyAcmeTotal;

  // Imported only: an ACME certificate's notAfter lives on the agent, and Caddy renews it.
  const nextExpiry = importedCerts.reduce<number | null>((soonest, cert) => {
    if (!cert.validTo) return soonest;
    const days = Math.ceil((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000);
    if (!Number.isFinite(days)) return soonest;
    return soonest === null || days < soonest ? days : soonest;
  }, null);

  const search =
    activeTab === "acme"
      ? searchAcme
      : activeTab === "imported"
        ? searchImported
        : activeTab === "roles"
          ? searchRoles
          : searchCa;
  const setSearch =
    activeTab === "acme"
      ? setSearchAcme
      : activeTab === "imported"
        ? setSearchImported
        : activeTab === "roles"
          ? setSearchRoles
          : setSearchCa;

  function handleTabChange(value: string) {
    setActiveTab(value as TabId);
    setStatusFilter(null);
  }

  return (
    <VStack gap={6}>
      <ListPageHeader
        title={t("sslTlsCertificates")}
        stats={
          <StatTiles
            tiles={[
              {
                id: "acme",
                label: t("acme"),
                value: acmePagination.total,
                note: t("acmeNote", { count: healthyAcmeTotal }),
              },
              {
                id: "imported",
                label: t("imported"),
                value: importedCerts.length,
                note:
                  nextExpiry === null
                    ? t("importedNoneNote")
                    : nextExpiry < 0
                      ? t("importedExpiredNote")
                      : t("importedNote", { count: nextExpiry }),
                accent:
                  expired > 0
                    ? { label: t("expiredAccent", { count: expired }), variant: "error" as const }
                    : expiringSoon > 0
                      ? {
                          label: t("expiringAccent", { count: expiringSoon }),
                          variant: "warning" as const,
                        }
                      : undefined,
              },
              {
                id: "ca",
                label: t("caMtls"),
                value: caCertificates.length,
                note: t("caNote", { count: issuedClientCerts.length }),
              },
              {
                id: "roles",
                label: t("roles"),
                value: mtlsRoles.length,
                note: t("rolesNote"),
              },
            ]}
          />
        }
        summary={
          <StatusSummaryBar
            expired={expired}
            expiringSoon={expiringSoon}
            healthy={healthy}
            filter={statusFilter}
            onFilter={setStatusFilter}
          />
        }
        filters={
          <TabList value={activeTab} onChange={handleTabChange}>
            <Tab
              value="acme"
              label={t("acme")}
              endContent={<Badge label={acmePagination.total} />}
            />
            <Tab
              value="imported"
              label={t("imported")}
              endContent={<Badge label={importedCerts.length} />}
            />
            <Tab
              value="ca"
              label={t("caMtls")}
              endContent={<Badge label={caCertificates.length} />}
            />
            <Tab value="roles" label={t("roles")} endContent={<Badge label={mtlsRoles.length} />} />
          </TabList>
        }
        search={
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={
              activeTab === "acme"
                ? t("searchByHostOrDomain")
                : activeTab === "imported"
                  ? t("searchByNameOrDomain")
                  : t("searchByName")
            }
            label={t("searchCertificates")}
          />
        }
      />

      <VStack gap={4}>
        {activeTab === "acme" && (
          <AcmeTab
            acmeHosts={acmeHosts}
            acmePagination={acmePagination}
            search={searchAcme}
            statusFilter={statusFilter}
          />
        )}
        {activeTab === "imported" && (
          <ImportedTab
            importedCerts={importedCerts}
            managedCerts={managedCerts}
            search={searchImported}
            statusFilter={statusFilter}
            fileAgents={fileAgents}
            dnsProviders={dnsProviders}
          />
        )}
        {activeTab === "ca" && (
          <CaTab caCertificates={caCertificates} search={searchCa} statusFilter={statusFilter} />
        )}
        {activeTab === "roles" && (
          <MtlsRolesTab roles={mtlsRoles} issuedCerts={issuedClientCerts} search={searchRoles} />
        )}
      </VStack>
    </VStack>
  );
}
