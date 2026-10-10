import { requireCan } from "@/src/lib/users/permissions";
import { X509Certificate } from "node:crypto";
import db from "@/src/lib/db";
import { proxyHosts, certificates } from "@/src/lib/db/schema";
import { isNull, isNotNull } from "drizzle-orm";
import CertificatesClient from "./CertificatesClient";
import { listCaCertificates, type CaCertificate } from "@/src/lib/models/ca-certificates";
import {
  listIssuedClientCertificates,
  type IssuedClientCertificate,
} from "@/src/lib/models/issued-client-certificates";
import { listMtlsRoles, type MtlsRole } from "@/src/lib/models/mtls-roles";
import { isDomainCoveredByCert } from "@/src/lib/certificates/domain-match";
import { countHealthyAcmeHosts } from "./certificate-summary";
import { listAgents } from "@/src/lib/models/agents";
import { certificateFileAgentOptions } from "@/src/lib/models/certificate-files";
import { getDnsProviderSettings } from "@/src/lib/settings";
import { configuredDnsProviderChoices, type DnsProviderChoice } from "@/src/lib/dns/providers";
import { parseStoredCertificateProviderOptions } from "@/src/lib/certificates/provider-options";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export type { CaCertificate };
export type { IssuedClientCertificate };
export type { MtlsRole };

export type CaCertificateView = CaCertificate & {
  issuedCerts: IssuedClientCertificate[];
};

export type CertExpiryStatus = "ok" | "expiring_soon" | "expired";

export type AcmeHost = {
  id: number;
  uuid: string;
  name: string;
  domains: string[];
  sslForced: boolean;
  enabled: boolean;
};

export type ImportedCertView = {
  type: "imported";
  id: number;
  name: string;
  domains: string[];
  validTo: string | null;
  validFrom: string | null;
  issuer: string | null;
  expiryStatus: CertExpiryStatus | null;
  usedBy: { id: number; name: string; domains: string[] }[];
  /** Set for a certificate read from files on an agent; null for an upload. */
  file: {
    agentId: number | null;
    /** Null once the agent is deleted. */
    agentName: string | null;
    certPath: string | null;
    keyPath: string | null;
    readAt: string | null;
    /** A `CertificateFileError` code. */
    error: string | null;
  } | null;
};

/** Connected agents with a certificate directory, for "From a file on an agent". */
export type CertificateFileAgent = { id: number; name: string };

/** `dnsProvider`: the DNS-01 provider chosen for this certificate alone; null means the default. */
export type ManagedCertView = {
  type: "managed";
  id: number;
  name: string;
  domains: string[];
  dnsProvider: string | null;
};

export type { DnsProviderChoice };

const PER_PAGE = 25;

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

function parsePemInfo(
  pem: string,
): { validTo: string; validFrom: string; issuer: string; sanDomains: string[] } | null {
  try {
    const c = new X509Certificate(pem);
    const sanDomains =
      c.subjectAltName
        ?.split(",")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("DNS:"))
        .map((s) => s.slice(4)) ?? [];
    const issuerLine = c.issuer ?? "";
    const issuer = (
      issuerLine.match(/O=([^\n,]+)/)?.[1] ??
      issuerLine.match(/CN=([^\n,]+)/)?.[1] ??
      issuerLine
    ).trim();
    return {
      validTo: new Date(c.validTo).toISOString(),
      validFrom: new Date(c.validFrom).toISOString(),
      issuer,
      sanDomains,
    };
  } catch {
    return null;
  }
}

function getExpiryStatus(validToIso: string): CertExpiryStatus {
  const diff = new Date(validToIso).getTime() - Date.now();
  if (diff < 0) return "expired";
  if (diff < 30 * 86400 * 1000) return "expiring_soon";
  return "ok";
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("certificates") };
}

export default async function CertificatesPage({ searchParams }: PageProps) {
  await requireCan("certificates:read");
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const offset = (page - 1) * PER_PAGE;
  const [
    caCerts,
    issuedClientCerts,
    mtlsRoles,
    allAcmeRows,
    certRows,
    usageRows,
    agentRows,
    dnsProviderSettings,
  ] = await Promise.all([
    listCaCertificates(),
    listIssuedClientCertificates(),
    listMtlsRoles().catch(() => []),
    db
      .select({
        id: proxyHosts.id,
        uuid: proxyHosts.uuid,
        name: proxyHosts.name,
        domains: proxyHosts.domains,
        sslForced: proxyHosts.sslForced,
        enabled: proxyHosts.enabled,
      })
      .from(proxyHosts)
      .where(isNull(proxyHosts.certificateId))
      .orderBy(proxyHosts.name),
    db.select().from(certificates),
    db
      .select({
        certId: proxyHosts.certificateId,
        hostId: proxyHosts.id,
        hostName: proxyHosts.name,
        hostDomains: proxyHosts.domains,
      })
      .from(proxyHosts)
      .where(isNotNull(proxyHosts.certificateId)),
    listAgents(),
    getDnsProviderSettings(),
  ]);
  const agentNames = new Map(agentRows.map((agent) => [agent.id, agent.name]));
  // Names only: the credentials stay on the server.
  const dnsProviders = configuredDnsProviderChoices(dnsProviderSettings);

  const allAcmeHosts: AcmeHost[] = allAcmeRows.map((r) => ({
    id: r.id,
    uuid: r.uuid ?? "",
    name: r.name,
    domains: JSON.parse(r.domains) as string[],
    sslForced: r.sslForced,
    enabled: r.enabled,
  }));

  const usageMap = new Map<number, { id: number; name: string; domains: string[] }[]>();
  for (const u of usageRows) {
    if (u.certId == null) continue;
    const hosts = usageMap.get(u.certId) ?? [];
    hosts.push({
      id: u.hostId,
      name: u.hostName,
      domains: JSON.parse(u.hostDomains) as string[],
    });
    usageMap.set(u.certId, hosts);
  }

  const certDomainMap = new Map<number, string[]>();
  for (const cert of certRows) {
    const domainNames = JSON.parse(cert.domainNames) as string[];
    // For imported certs, also check PEM SANs which may include wildcards
    if (cert.type === "imported" && cert.certificatePem) {
      const pemInfo = parsePemInfo(cert.certificatePem);
      if (pemInfo?.sanDomains.length) {
        certDomainMap.set(cert.id, pemInfo.sanDomains);
        continue;
      }
    }
    certDomainMap.set(cert.id, domainNames);
  }

  // Filter out ACME hosts whose domains are fully covered by an existing certificate's wildcard,
  // and attribute them to that certificate's usedBy list instead.
  const filteredAcmeHosts: AcmeHost[] = [];
  for (const host of allAcmeHosts) {
    let coveredByCertId: number | null = null;
    for (const [certId, certDomains] of certDomainMap) {
      if (host.domains.every((d) => isDomainCoveredByCert(d, certDomains))) {
        coveredByCertId = certId;
        break;
      }
    }
    if (coveredByCertId !== null) {
      const hosts = usageMap.get(coveredByCertId) ?? [];
      hosts.push({ id: host.id, name: host.name, domains: host.domains });
      usageMap.set(coveredByCertId, hosts);
    } else {
      filteredAcmeHosts.push(host);
    }
  }

  // Among ACME auto-managed hosts, collapse subdomain hosts under wildcard hosts.
  // e.g. if *.domain.de is an ACME host, sub.domain.de should not appear separately.
  const wildcardAcmeHosts = filteredAcmeHosts.filter((h) =>
    h.domains.some((d) => d.startsWith("*.")),
  );
  const wildcardDomainSets = wildcardAcmeHosts.map((h) => h.domains);
  const deduplicatedAcmeHosts: AcmeHost[] = [];
  for (const host of filteredAcmeHosts) {
    // Never collapse a host that itself has a wildcard domain
    if (host.domains.some((d) => d.startsWith("*."))) {
      deduplicatedAcmeHosts.push(host);
      continue;
    }
    const coveredByWildcard = wildcardDomainSets.some((wcDomains) =>
      host.domains.every((d) => isDomainCoveredByCert(d, wcDomains)),
    );
    if (!coveredByWildcard) {
      deduplicatedAcmeHosts.push(host);
    }
  }

  const adjustedAcmeTotal = deduplicatedAcmeHosts.length;
  const healthyAcmeTotal = countHealthyAcmeHosts(deduplicatedAcmeHosts);
  const paginatedAcmeHosts = deduplicatedAcmeHosts.slice(offset, offset + PER_PAGE);

  const importedCerts: ImportedCertView[] = [];
  const managedCerts: ManagedCertView[] = [];
  const issuedByCa = issuedClientCerts.reduce<Map<number, IssuedClientCertificate[]>>(
    (map, cert) => {
      const current = map.get(cert.caCertificateId) ?? [];
      current.push(cert);
      map.set(cert.caCertificateId, current);
      return map;
    },
    new Map(),
  );
  const caCertificateViews: CaCertificateView[] = caCerts.map((cert) => ({
    ...cert,
    issuedCerts: issuedByCa.get(cert.id) ?? [],
  }));

  for (const cert of certRows) {
    const domainNames = JSON.parse(cert.domainNames) as string[];
    if (cert.type === "imported") {
      const pemInfo = cert.certificatePem ? parsePemInfo(cert.certificatePem) : null;
      importedCerts.push({
        type: "imported",
        id: cert.id,
        name: cert.name,
        domains: pemInfo?.sanDomains.length ? pemInfo.sanDomains : domainNames,
        validTo: pemInfo?.validTo ?? null,
        validFrom: pemInfo?.validFrom ?? null,
        issuer: pemInfo?.issuer ?? null,
        expiryStatus: pemInfo?.validTo ? getExpiryStatus(pemInfo.validTo) : null,
        usedBy: usageMap.get(cert.id) ?? [],
        file:
          cert.source === "agent-file"
            ? {
                agentId: cert.sourceAgentId,
                agentName:
                  cert.sourceAgentId === null ? null : (agentNames.get(cert.sourceAgentId) ?? null),
                certPath: cert.sourceCertPath,
                keyPath: cert.sourceKeyPath,
                readAt: cert.sourceReadAt,
                error: cert.sourceError,
              }
            : null,
      });
    } else {
      managedCerts.push({
        type: "managed",
        id: cert.id,
        name: cert.name,
        domains: domainNames,
        dnsProvider: parseStoredCertificateProviderOptions(cert.providerOptions)?.provider ?? null,
      });
    }
  }

  return (
    <CertificatesClient
      acmeHosts={paginatedAcmeHosts}
      importedCerts={importedCerts}
      managedCerts={managedCerts}
      caCertificates={caCertificateViews}
      acmePagination={{ total: adjustedAcmeTotal, page, perPage: PER_PAGE }}
      healthyAcmeTotal={healthyAcmeTotal}
      mtlsRoles={mtlsRoles}
      issuedClientCerts={issuedClientCerts}
      fileAgents={certificateFileAgentOptions()}
      dnsProviders={dnsProviders}
    />
  );
}
