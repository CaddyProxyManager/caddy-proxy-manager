/**
 * Who must have a second factor, and by when. Pure: the settings module stores the shape, the
 * policy module asks it about a session, and the Settings form and the users list read it too.
 *
 * A passkey counts (it is both factors at once). Accounts without a local password are exempt:
 * their identity provider or directory decides about a second factor.
 */

export const MFA_POLICY_MODES = ["off", "admins", "all"] as const;

export type MfaPolicyMode = (typeof MFA_POLICY_MODES)[number];

export const DEFAULT_MFA_GRACE_DAYS = 7;
export const MAX_MFA_GRACE_DAYS = 90;

export type TwoFactorPolicySettings = {
  mode: MfaPolicyMode;
  /** Days an account newly covered has before setup is forced at sign-in. */
  graceDays: number;
  /**
   * When the mode last changed, which starts every grace period then running. Null for a policy
   * stored before grace periods, which was enforced at once and still is.
   */
  since: string | null;
  /** The pre-policy shape, kept for API clients: true whenever administrators are covered. */
  requireForAdmins: boolean;
};

export const DEFAULT_MFA_POLICY: TwoFactorPolicySettings = {
  mode: "off",
  graceDays: DEFAULT_MFA_GRACE_DAYS,
  since: null,
  requireForAdmins: false,
};

export function isMfaPolicyMode(value: unknown): value is MfaPolicyMode {
  return (MFA_POLICY_MODES as readonly unknown[]).includes(value);
}

function graceDaysFrom(value: unknown): number {
  const days = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(days)) return DEFAULT_MFA_GRACE_DAYS;
  return Math.min(MAX_MFA_GRACE_DAYS, Math.max(0, Math.round(days)));
}

/** The stored row, whichever shape. `{ requireForAdmins: true }` is the "admins" mode. */
export function readMfaPolicy(stored: unknown): TwoFactorPolicySettings {
  const raw =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const mode: MfaPolicyMode = isMfaPolicyMode(raw.mode)
    ? raw.mode
    : raw.requireForAdmins === true
      ? "admins"
      : "off";
  const since = typeof raw.since === "string" && raw.since ? raw.since : null;
  return {
    mode,
    graceDays: "graceDays" in raw ? graceDaysFrom(raw.graceDays) : DEFAULT_MFA_GRACE_DAYS,
    since,
    requireForAdmins: mode !== "off",
  };
}

/**
 * What a save stores. A changed mode restarts the grace clock; the same mode keeps the one running,
 * so changing only the days never hands everyone a fresh period.
 */
export function nextMfaPolicy(
  previous: TwoFactorPolicySettings,
  input: { mode: MfaPolicyMode; graceDays: number },
  now: Date = new Date(),
): TwoFactorPolicySettings {
  const since = input.mode === previous.mode ? previous.since : now.toISOString();
  return {
    mode: input.mode,
    graceDays: graceDaysFrom(input.graceDays),
    since: input.mode === "off" ? null : since,
    requireForAdmins: input.mode !== "off",
  };
}

export type MfaSubject = {
  role: string;
  /** A local password: what a second factor protects, and what single sign-on lacks. */
  hasPassword: boolean;
  twoFactorEnabled: boolean;
  passkeyCount: number;
  createdAt: string | null;
};

export function coveredByMfaPolicy(policy: TwoFactorPolicySettings, subject: MfaSubject): boolean {
  if (policy.mode === "off" || !subject.hasPassword) return false;
  return policy.mode === "all" || subject.role === "admin";
}

export function hasSecondFactor(subject: Pick<MfaSubject, "twoFactorEnabled" | "passkeyCount">) {
  return subject.twoFactorEnabled || subject.passkeyCount > 0;
}

export type MfaStanding =
  | { status: "exempt" }
  | { status: "satisfied" }
  /** Setup is due by `deadline`; the dashboard shows a banner until then. */
  | { status: "grace"; deadline: string }
  /** Setup is forced at the next page load. */
  | { status: "required" };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The grace period runs from the later of the policy change and the account's creation. */
export function mfaStanding(
  policy: TwoFactorPolicySettings,
  subject: MfaSubject,
  now: Date = new Date(),
): MfaStanding {
  if (!coveredByMfaPolicy(policy, subject)) return { status: "exempt" };
  if (hasSecondFactor(subject)) return { status: "satisfied" };
  if (policy.since === null) return { status: "required" };
  const since = Date.parse(policy.since);
  const created = subject.createdAt ? Date.parse(subject.createdAt) : Number.NaN;
  const start = Number.isNaN(created) ? since : Math.max(since, created);
  if (Number.isNaN(start)) return { status: "required" };
  const deadline = start + policy.graceDays * DAY_MS;
  return deadline > now.getTime()
    ? { status: "grace", deadline: new Date(deadline).toISOString() }
    : { status: "required" };
}
