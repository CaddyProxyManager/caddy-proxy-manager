/**
 * When each certificate a host serves runs out, and whether that is trouble. Imported ones come
 * from their PEM; Caddy-managed ones from the agents' inventory, which runs a container on every
 * agent, so it is cached and read under a budget rather than asked for on every page load.
 */

import { X509Certificate } from "node:crypto";
import type { CaddyCertificate } from "@cpm/shared";
import { isDomainCoveredByCert } from "./domain-match";

const DAY_MS = 86_400_000;
/** Caddy renews at a third of the lifetime left; past this many days a managed one is failing. */
export const DEFAULT_TROUBLE_DAYS = 14;

export type CertificateExpiry = {
  /** Imported certificate id, or null for one Caddy manages. */
  certificateId: number | null;
  name: string;
  names: string[];
  notBefore: string | null;
  notAfter: string;
  managed: boolean;
  /** The agent reporting a managed one. */
  agent: string | null;
};

export type CertificateStage = "expired" | "expiring" | null;

/** Unparseable PEM yields nothing: it is refused on import, so one that slipped in is not ours. */
export function importedExpiry(certificate: {
  id: number;
  name: string;
  type: string;
  domainNames: string[];
  certificatePem: string | null;
}): CertificateExpiry | null {
  if (certificate.type !== "imported" || !certificate.certificatePem) return null;
  try {
    const x509 = new X509Certificate(certificate.certificatePem);
    return {
      certificateId: certificate.id,
      name: certificate.name,
      names: certificate.domainNames,
      notBefore: new Date(x509.validFrom).toISOString(),
      notAfter: new Date(x509.validTo).toISOString(),
      managed: false,
      agent: null,
    };
  } catch {
    return null;
  }
}

export function managedExpiry(agent: string, certificate: CaddyCertificate): CertificateExpiry {
  return {
    certificateId: null,
    name: certificate.names.length > 0 ? certificate.names.join(", ") : certificate.name,
    names: certificate.names.length > 0 ? certificate.names : [certificate.name],
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
    managed: true,
    agent,
  };
}

/**
 * As the expiry emails judge it: a managed one must also be in the last quarter of its life, or
 * Caddy's 12-hour internal certificates would always be "expiring".
 */
export function certificateStage(
  expiry: Pick<CertificateExpiry, "notBefore" | "notAfter" | "managed">,
  thresholdDays: number,
  now: number,
): CertificateStage {
  const notAfter = Date.parse(expiry.notAfter);
  if (!Number.isFinite(notAfter)) return null;
  const remaining = notAfter - now;
  if (remaining <= 0) return "expired";
  if (remaining >= thresholdDays * DAY_MS) return null;
  if (expiry.managed) {
    const lifetime = notAfter - Date.parse(expiry.notBefore ?? "");
    if (Number.isFinite(lifetime) && lifetime > 0 && remaining >= lifetime / 4) return null;
  }
  return "expiring";
}

/** Whole days, rounded down; negative once expired. */
export function daysLeft(notAfter: string, now: number): number | null {
  const at = Date.parse(notAfter);
  return Number.isFinite(at) ? Math.floor((at - now) / DAY_MS) : null;
}

export type HostCertificate = {
  expiry: CertificateExpiry;
  daysLeft: number | null;
  stage: CertificateStage;
};

/**
 * The certificate that runs out first across the host's names: its own imported one, or else the
 * newest managed certificate per name. Null when nothing is known, e.g. no agent answered.
 */
export function hostCertificate(
  host: { domains: string[]; certificateId: number | null },
  imported: ReadonlyMap<number, CertificateExpiry>,
  managed: readonly CertificateExpiry[] | null,
  thresholdDays: number,
  now: number,
): HostCertificate | null {
  let chosen: CertificateExpiry | null = null;
  if (host.certificateId !== null) {
    chosen = imported.get(host.certificateId) ?? null;
  } else if (managed) {
    for (const domain of host.domains.map((d) => d.trim().toLowerCase()).filter(Boolean)) {
      let newest: CertificateExpiry | null = null;
      for (const candidate of managed) {
        if (!isDomainCoveredByCert(domain, candidate.names)) continue;
        if (!newest || Date.parse(candidate.notAfter) > Date.parse(newest.notAfter)) {
          newest = candidate;
        }
      }
      if (newest && (!chosen || Date.parse(newest.notAfter) < Date.parse(chosen.notAfter))) {
        chosen = newest;
      }
    }
  }
  if (!chosen) return null;
  return {
    expiry: chosen,
    daysLeft: daysLeft(chosen.notAfter, now),
    stage: certificateStage(chosen, thresholdDays, now),
  };
}

// ── Server reads ─────────────────────────────────────────────────────────────

const INVENTORY_MAX_AGE_MS = 10 * 60 * 1000;

type Inventory = { at: number; certificates: CertificateExpiry[] };
let cached: Inventory | null = null;
let refreshing: Promise<Inventory> | null = null;

async function refreshInventory(): Promise<Inventory> {
  const { listAgentCertificates } = await import("../agent/client");
  const agents = await listAgentCertificates();
  const certificates = agents.flatMap((agent) =>
    (agent.certificates ?? []).map((certificate) => managedExpiry(agent.name, certificate)),
  );
  // An agent that did not answer is not "no certificates": keep what it said last time.
  const silent = new Set(agents.filter((a) => !a.certificates).map((a) => a.name));
  const kept = (cached?.certificates ?? []).filter((c) => c.agent && silent.has(c.agent));
  return { at: Date.now(), certificates: [...certificates, ...kept] };
}

/**
 * Managed certificates from the cache, refreshed in the background once stale. Waits at most
 * `budgetMs` for a refresh; null when there has never been an answer.
 */
export async function managedCertificates(budgetMs = 2000): Promise<CertificateExpiry[] | null> {
  const now = Date.now();
  if (cached && now - cached.at < INVENTORY_MAX_AGE_MS) return cached.certificates;
  refreshing ??= refreshInventory()
    .then((inventory) => {
      cached = inventory;
      return inventory;
    })
    .finally(() => {
      refreshing = null;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    const fresh = await Promise.race([refreshing.catch(() => null), late]);
    return fresh?.certificates ?? cached?.certificates ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam. */
export function resetCertificateInventoryForTests(): void {
  cached = null;
  refreshing = null;
}

/** The alert threshold, or the default when alerts are off: trouble is trouble either way. */
export async function certificateTroubleDays(): Promise<number> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const days = await getSetting(registry.certificateExpiryAlertDays);
  return days > 0 ? days : DEFAULT_TROUBLE_DAYS;
}
