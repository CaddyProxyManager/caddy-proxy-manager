/**
 * The overview's first-steps checklist. Each step is detected from what the instance holds; an
 * administrator can also mark one done by hand, or hide the whole list. That choice is one
 * settings row per instance, outside staging: it is a view preference, not configuration.
 */

import { logAuditEvent } from "../audit";
import { domainError } from "../errors/domain-error";
import { getSetting, setSetting } from "../settings";
import { outsideStagingScope } from "../settings/staging-context";
import {
  isSetupStep,
  SETUP_STEPS,
  type SetupChecklist,
  type SetupChecklistState,
  type SetupStep,
} from "./steps";

export * from "./steps";

const STATE_KEY = "setup_checklist";

export function normalizeChecklistState(raw: unknown): SetupChecklistState {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const done = Array.isArray(value.done) ? value.done.filter(isSetupStep) : [];
  return { hidden: value.hidden === true, done: SETUP_STEPS.filter((s) => done.includes(s)) };
}

export async function getChecklistState(): Promise<SetupChecklistState> {
  return normalizeChecklistState(await outsideStagingScope(() => getSetting<unknown>(STATE_KEY)));
}

async function saveChecklistState(state: SetupChecklistState): Promise<void> {
  await outsideStagingScope(() => setSetting(STATE_KEY, state));
}

/** Each step's own test. A failed read leaves the step undetected rather than failing the page. */
export async function detectSetupSteps(): Promise<Record<SetupStep, boolean>> {
  const quietly = (work: () => Promise<boolean>) => work().catch(() => false);
  const [certificate, proxyHost, analytics, secondUser, sso] = await Promise.all([
    quietly(hasValidCertificate),
    quietly(async () => {
      const [{ default: db }, { proxyHosts }, { count }] = await Promise.all([
        import("../db"),
        import("../db/schema"),
        import("drizzle-orm"),
      ]);
      const [row] = await db.select({ value: count() }).from(proxyHosts);
      return (row?.value ?? 0) > 0;
    }),
    quietly(async () => (await import("../clickhouse/client")).isAnalyticsEnabled()),
    quietly(async () => (await (await import("../models/user")).getUserCount()) >= 2),
    quietly(async () => {
      const [{ listOAuthProviders }, { listLdapDirectories }] = await Promise.all([
        import("../models/oauth-providers"),
        import("../models/ldap-directories"),
      ]);
      const [oidc, ldap] = await Promise.all([listOAuthProviders(), listLdapDirectories()]);
      return oidc.length + ldap.length > 0;
    }),
  ]);
  return { certificate, proxyHost, analytics, secondUser, sso };
}

/** An imported certificate still in date, or one Caddy issued for a host. */
async function hasValidCertificate(): Promise<boolean> {
  const [{ listCertificates }, expiry] = await Promise.all([
    import("../models/certificates"),
    import("../certificates/expiry"),
  ]);
  const now = Date.now();
  const valid = (notAfter: string) => Date.parse(notAfter) > now;
  for (const row of await listCertificates()) {
    const found = expiry.importedExpiry(row);
    if (found && valid(found.notAfter)) return true;
  }
  const managed = await expiry.managedCertificates(1500);
  // Caddy's internal CA certificates are short-lived stand-ins, not a domain's certificate.
  return (managed ?? []).some((c) => valid(c.notAfter) && c.names.some((n) => n.includes(".")));
}

export async function getSetupChecklist(): Promise<SetupChecklist> {
  const [state, detected] = await Promise.all([getChecklistState(), detectSetupSteps()]);
  return {
    hidden: state.hidden,
    steps: SETUP_STEPS.map((step) => ({
      step,
      detected: detected[step],
      markedDone: state.done.includes(step),
    })),
  };
}

export async function setSetupStepDone(
  step: string,
  done: boolean,
  actorUserId: number,
): Promise<SetupChecklistState> {
  if (!isSetupStep(step)) throw domainError("setupStepUnknown", {}, { status: 400 });
  const state = await getChecklistState();
  const next: SetupChecklistState = {
    ...state,
    done: SETUP_STEPS.filter((s) => (s === step ? done : state.done.includes(s))),
  };
  await saveChecklistState(next);
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "setup_checklist",
    summary: done ? `Marked setup step ${step} done` : `Marked setup step ${step} not done`,
  });
  return next;
}

export async function setSetupChecklistHidden(
  hidden: boolean,
  actorUserId: number,
): Promise<SetupChecklistState> {
  const next = { ...(await getChecklistState()), hidden };
  await saveChecklistState(next);
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "setup_checklist",
    summary: hidden ? "Hid the setup checklist" : "Showed the setup checklist",
  });
  return next;
}
