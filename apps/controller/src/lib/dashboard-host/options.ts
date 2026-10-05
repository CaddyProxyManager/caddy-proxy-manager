/**
 * Out of dashboard-host/index.ts, which caddy/index.ts imports: this needs the proxy host model, which imports
 * caddy/index.ts, so living there would close a cycle.
 */
import {
  type DashboardHostOptions,
  type DashboardHostSettings,
  EMPTY_DASHBOARD_HOST_OPTIONS,
} from "./index";
import { parseAccessListId, parseCertificateId } from "../forms/form-parse";
import { agentIdsForHost, parseAgentIds } from "../models/host-agents";
import {
  assertProxyHostOptionsStorable,
  getProxyHost,
  getProxyHostMeta,
  listProxyHosts,
  mergeProxyHostMeta,
  type ProxyHost,
  type ProxyHostMetaView,
  proxyHostMetaView,
} from "../models/proxy-hosts";
import { parseProxyHostOptionUpdates, validateAndSanitizeCertificateId } from "../proxy-hosts/form";
import { getWafSettings } from "../settings";

export type DashboardHostFormView = ProxyHostMetaView & {
  certificateId: number | null;
  accessListId: number | null;
  hstsSubdomains: boolean;
  skipHttpsHostnameValidation: boolean;
  agentIds: number[];
};

export function dashboardHostFormView(options?: DashboardHostOptions): DashboardHostFormView {
  const current = options ?? EMPTY_DASHBOARD_HOST_OPTIONS;
  return {
    ...proxyHostMetaView(current.meta),
    certificateId: current.certificateId,
    accessListId: current.accessListId,
    hstsSubdomains: current.hstsSubdomains,
    skipHttpsHostnameValidation: current.skipHttpsHostnameValidation,
    agentIds: current.agentIds,
  };
}

/**
 * Its grants are keyed by host id, which the dashboard host lacks, and gating the dashboard behind
 * the sign-in it serves is a loop, not a protection. Maintenance mode would lock out the admin who
 * has to turn it off again, and a bot challenge every agent and API client.
 */
function withoutForwardAuth(meta: string | null): string | null {
  return mergeProxyHostMeta(meta, { cpmForwardAuth: null, maintenance: null, anubis: null });
}

/**
 * An unrendered section is left as it was; a form with no option fields (the setup step) keeps
 * `existing` whole. Throws the model's domain errors for what a stored host would refuse.
 */
export async function readDashboardHostOptions(
  formData: FormData,
  existing: DashboardHostOptions | undefined,
  domain: string,
): Promise<DashboardHostOptions> {
  const base = existing ?? EMPTY_DASHBOARD_HOST_OPTIONS;
  if (!formData.has("dashboardOptionsPresent")) return base;

  const { certificateId, warning } = formData.has("certificateId")
    ? await validateAndSanitizeCertificateId(parseCertificateId(formData.get("certificateId")))
    : { certificateId: base.certificateId, warning: undefined };
  if (warning) console.warn(`[readDashboardHostOptions] ${warning}`);

  const accessListId = formData.has("accessListId")
    ? parseAccessListId(formData.get("accessListId"))
    : base.accessListId;
  const agentIds = formData.has("agentAssignmentPresent")
    ? parseAgentIds(formData.getAll("agentId"))
    : base.agentIds;

  const updates = parseProxyHostOptionUpdates(formData);
  const globalWaf = updates.waf ? await getWafSettings() : null;
  const meta = withoutForwardAuth(mergeProxyHostMeta(base.meta, updates, globalWaf));

  await assertProxyHostOptionsStorable({
    domains: [domain],
    certificateId,
    agentIds,
    meta,
    customCaddyfileChanged:
      updates.customCaddyfile !== undefined &&
      proxyHostMetaView(meta).customCaddyfile !== proxyHostMetaView(base.meta).customCaddyfile,
    previousMeta: base.meta,
    target: { kind: "dashboard" },
  });

  return {
    certificateId,
    accessListId,
    hstsSubdomains: updates.hstsSubdomains ?? base.hstsSubdomains,
    skipHttpsHostnameValidation:
      updates.skipHttpsHostnameValidation ?? base.skipHttpsHostnameValidation,
    agentIds,
    meta,
  };
}

export type DomainClaim = { id: number; name: string; domains: string[]; enabled: boolean };

/** Exact names only: the route sort already puts an exact domain ahead of a wildcard host. */
export async function listDomainClaims(): Promise<DomainClaim[]> {
  const hosts = await listProxyHosts();
  return hosts.map((host) => ({
    id: host.id,
    name: host.name,
    domains: host.domains.map((domain) => domain.toLowerCase()),
    enabled: host.enabled,
  }));
}

/**
 * Null when the host changed since the form was drawn. HTTPS is carried over, not reset: HSTS has
 * pinned the host's visitors to HTTPS, so a plain-HTTP dashboard would be unreachable for them.
 */
export async function dashboardSettingsFromHost(
  hostId: number,
  domain: string,
): Promise<{ settings: DashboardHostSettings; host: ProxyHost } | null> {
  const name = domain.trim().toLowerCase();
  const host = await getProxyHost(hostId);
  if (!host?.domains.some((claimed) => claimed.toLowerCase() === name)) return null;

  const [meta, agentIds] = await Promise.all([
    getProxyHostMeta(hostId),
    agentIdsForHost("http", hostId),
  ]);

  return {
    host,
    settings: {
      enabled: true,
      domain: name,
      tls: host.sslForced,
      options: {
        certificateId: host.certificateId,
        accessListId: host.accessListId,
        hstsSubdomains: host.hstsSubdomains,
        skipHttpsHostnameValidation: host.skipHttpsHostnameValidation,
        agentIds,
        meta: withoutForwardAuth(meta),
      },
    },
  };
}
