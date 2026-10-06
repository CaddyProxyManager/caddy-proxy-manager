/**
 * Emails the alert recipients about certificates close to expiry: imported ones, which nothing
 * renews, and Caddy-managed ones that are past the point Caddy should have renewed them. Each
 * certificate is reported once per stage (expiring, then expired), so a daily pass never repeats.
 */

import { X509Certificate } from "node:crypto";
import { isEmailAddress } from "./address";
import { getSetting as getStoredJson, setSetting as setStoredJson } from "../settings";
import { emailReady } from "./config";
import { type CertificateAlertItem, certificateAlertEmail } from "./messages";
import { sendEmail } from "./transport";

const STATE_KEY = "certificate_expiry_alerts";
const DAY_MS = 86_400_000;
/** Each pass lists certificates through a throwaway container on every agent; twice a day will do. */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const WAKE_MS = 60 * 60 * 1000;
/** Past startup, so agents have reconnected and their certificates are in the first pass. */
const FIRST_WAKE_MS = 5 * 60 * 1000;

export type AlertStage = "expiring" | "expired";

export type CertificateAlertState = {
  checkedAt: string | null;
  /** English, for the log and the Settings page; null after a clean pass. */
  error: string | null;
  /** The stage each certificate was last reported at, by `ExpiryCandidate.key`. */
  alerted: Record<string, AlertStage>;
};

export type ExpiryCandidate = {
  /** Changes when the certificate does, so a renewed one starts over. */
  key: string;
  /** Whose report the key came from; its entries survive a pass the agent did not answer. */
  agentId: string | null;
  /** Renewed by Caddy, which starts at a third of the lifetime left. */
  managed: boolean;
  notBefore: string | null;
  item: CertificateAlertItem;
};

export async function getCertificateAlertState(): Promise<CertificateAlertState> {
  const stored = await getStoredJson<Partial<CertificateAlertState>>(STATE_KEY);
  return {
    checkedAt: stored?.checkedAt ?? null,
    error: stored?.error ?? null,
    alerted: stored?.alerted ?? {},
  };
}

/**
 * A managed certificate must also be inside the last quarter of its life: Caddy's internal CA
 * issues 12-hour certificates, which a threshold in days alone would report on every pass.
 */
export function alertStage(
  candidate: ExpiryCandidate,
  thresholdDays: number,
  now: number,
): AlertStage | null {
  const notAfter = Date.parse(candidate.item.notAfter);
  if (!Number.isFinite(notAfter)) return null;
  const remaining = notAfter - now;
  if (remaining <= 0) return "expired";
  if (remaining >= thresholdDays * DAY_MS) return null;
  if (candidate.managed) {
    const notBefore = Date.parse(candidate.notBefore ?? "");
    const lifetime = notAfter - notBefore;
    if (Number.isFinite(lifetime) && lifetime > 0 && remaining >= lifetime / 4) return null;
  }
  return "expiring";
}

/** What to send, and what to remember, from this pass's certificates and the last pass's state. */
export function planCertificateAlerts(
  candidates: readonly ExpiryCandidate[],
  previous: Record<string, AlertStage>,
  unansweredAgents: ReadonlySet<string>,
  thresholdDays: number,
  now: number,
): { toSend: ExpiryCandidate[]; alerted: Record<string, AlertStage> } {
  const alerted: Record<string, AlertStage> = {};
  const toSend: ExpiryCandidate[] = [];
  for (const candidate of candidates) {
    const stage = alertStage(candidate, thresholdDays, now);
    if (!stage) continue;
    alerted[candidate.key] = stage;
    if (previous[candidate.key] !== stage) toSend.push(candidate);
  }
  // Kept, or an agent that misses one pass has all its certificates reported again on the next.
  for (const [key, stage] of Object.entries(previous)) {
    const agentId = key.startsWith("agent:") ? key.split(":")[1] : null;
    if (agentId && unansweredAgents.has(agentId) && !(key in alerted)) alerted[key] = stage;
  }
  return { toSend, alerted };
}

async function importedCandidates(): Promise<ExpiryCandidate[]> {
  const { listCertificates } = await import("../models/certificates");
  const candidates: ExpiryCandidate[] = [];
  for (const certificate of await listCertificates()) {
    if (certificate.type !== "imported" || !certificate.certificatePem) continue;
    try {
      const x509 = new X509Certificate(certificate.certificatePem);
      const notAfter = new Date(x509.validTo).toISOString();
      candidates.push({
        key: `imported:${certificate.id}:${x509.fingerprint256}`,
        agentId: null,
        managed: false,
        notBefore: new Date(x509.validFrom).toISOString(),
        item: { name: certificate.name, notAfter, source: { kind: "imported" } },
      });
    } catch {
      // Unparseable PEM is refused on import; one that slipped in is not this job's to report.
    }
  }
  return candidates;
}

async function managedCandidates(): Promise<{
  candidates: ExpiryCandidate[];
  unanswered: Set<string>;
}> {
  const { listAgentCertificates } = await import("../agent/client");
  const candidates: ExpiryCandidate[] = [];
  const unanswered = new Set<string>();
  for (const agent of await listAgentCertificates()) {
    if (!agent.certificates) {
      unanswered.add(agent.agentId);
      continue;
    }
    for (const certificate of agent.certificates) {
      candidates.push({
        key: `agent:${agent.agentId}:${certificate.fingerprint}`,
        agentId: agent.agentId,
        managed: true,
        notBefore: certificate.notBefore,
        item: {
          name: certificate.names.length > 0 ? certificate.names.join(", ") : certificate.name,
          notAfter: certificate.notAfter,
          source: { kind: "agent", name: agent.name },
        },
      });
    }
  }
  return { candidates, unanswered };
}

/** The configured addresses, else every active administrator with a deliverable one. */
export async function alertRecipients(): Promise<string[]> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const configured = (await getSetting(registry.emailAlertRecipients))
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;

  const { listUsers } = await import("../models/user");
  // `name@localhost`, as setup names the first administrator, has nowhere to be delivered.
  return (await listUsers())
    .filter((user) => user.role === "admin" && user.status === "active")
    .map((user) => user.email)
    .filter((email) => isEmailAddress(email, "public"));
}

export type CertificateAlertOutcome =
  | { skipped: "disabled" | "email" | "no-recipients" }
  | { sent: number };

export async function runCertificateExpiryAlerts(
  now = Date.now(),
): Promise<CertificateAlertOutcome> {
  const [registry, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const thresholdDays = await getSetting(registry.certificateExpiryAlertDays);
  if (thresholdDays === 0) return { skipped: "disabled" };
  if (!(await emailReady())) return { skipped: "email" };

  const previous = await getCertificateAlertState();
  const checkedAt = new Date(now).toISOString();
  try {
    const [imported, managed] = await Promise.all([importedCandidates(), managedCandidates()]);
    const plan = planCertificateAlerts(
      [...imported, ...managed.candidates],
      previous.alerted,
      managed.unanswered,
      thresholdDays,
      now,
    );

    if (plan.toSend.length > 0) {
      const recipients = await alertRecipients();
      if (recipients.length === 0) {
        await setStoredJson(STATE_KEY, { ...previous, checkedAt, error: null });
        return { skipped: "no-recipients" };
      }
      await sendEmail(
        await certificateAlertEmail({
          to: recipients,
          items: plan.toSend.map((candidate) => candidate.item),
          thresholdDays,
          now,
        }),
      );
    }

    await setStoredJson<CertificateAlertState>(STATE_KEY, {
      checkedAt,
      error: null,
      alerted: plan.alerted,
    });
    return { sent: plan.toSend.length };
  } catch (error) {
    // The previous stages stay, so what failed to send is sent on the next pass.
    const message = error instanceof Error ? error.message : String(error);
    await setStoredJson<CertificateAlertState>(STATE_KEY, {
      ...previous,
      checkedAt,
      error: message,
    });
    throw error;
  }
}

export function certificateAlertsDue(checkedAt: string | null, now = Date.now()): boolean {
  if (!checkedAt) return true;
  const last = Date.parse(checkedAt);
  return !Number.isFinite(last) || now - last >= CHECK_INTERVAL_MS;
}

let timer: NodeJS.Timeout | null = null;

/** Idempotent. */
export function startCertificateExpiryAlerts(): void {
  if (timer) return;
  const wake = () => {
    void getCertificateAlertState()
      .then((state) =>
        certificateAlertsDue(state.checkedAt) ? runCertificateExpiryAlerts() : null,
      )
      .catch((error: unknown) => {
        console.error("[certificate-alerts] scheduled check failed:", error);
      });
  };
  timer = setTimeout(() => {
    wake();
    timer = setInterval(wake, WAKE_MS);
    timer.unref();
  }, FIRST_WAKE_MS);
  timer.unref();
}

/** On losing the lead (lib/cluster); clearTimeout and clearInterval take either handle. */
export function stopCertificateExpiryAlerts(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
