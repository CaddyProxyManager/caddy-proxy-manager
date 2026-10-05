/** The host page's data, as the server hands it over. Client safe. */

import type { AttentionList } from "../attention/types";
import type { CertificateStage } from "../certificates/expiry";
import type { HostTrafficReport } from "../clickhouse/host-traffic";
import type { ProxyHost } from "../models/proxy-hosts";
import type { HostProtections } from "./protections";
import type { SectionSummary } from "./section-summary";
import type { HostStatus } from "./traffic-status";

export type HostHealthChecks = {
  active: { uri: string | null; interval: string | null; timeout: string | null } | null;
  passive: { maxFails: number | null; failDuration: string | null } | null;
};

export type HostCertificateSummary = {
  name: string;
  managed: boolean;
  notAfter: string;
  daysLeft: number | null;
  stage: CertificateStage;
};

export type HostAuditEntry = {
  id: number;
  userId: number | null;
  action: string;
  entityType: string;
  summary: string | null;
  createdAt: string;
};

export type ProxyHostDetail = {
  host: ProxyHost;
  status: HostStatus;
  attention: AttentionList;
  traffic: HostTrafficReport | null;
  certificate: HostCertificateSummary | null;
  protections: HostProtections;
  sections: SectionSummary[];
  healthChecks: HostHealthChecks;
  /** Administrators only, as the audit log is. */
  audit: HostAuditEntry[];
};

export const HOST_AUDIT_LIMIT = 10;

export function healthChecksOf(host: Pick<ProxyHost, "loadBalancer">): HostHealthChecks {
  const lb = host.loadBalancer;
  const active = lb?.enabled && lb.activeHealthCheck?.enabled ? lb.activeHealthCheck : null;
  const passive = lb?.enabled && lb.passiveHealthCheck?.enabled ? lb.passiveHealthCheck : null;
  return {
    active: active
      ? {
          uri: active.uri ?? null,
          interval: active.interval ?? null,
          timeout: active.timeout ?? null,
        }
      : null,
    passive: passive
      ? { maxFails: passive.maxFails ?? null, failDuration: passive.failDuration ?? null }
      : null,
  };
}
