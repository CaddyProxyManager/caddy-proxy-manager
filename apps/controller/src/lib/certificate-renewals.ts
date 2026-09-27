/**
 * Caddy has no renew endpoint, but renews on load whatever sits inside its policy's window. So the
 * name gets its own wide-window policy until a newer cert appears, after a load that unmanages it -
 * the cache outlives reloads. In memory: a request lost to a restart just renews on schedule.
 */

/** For a certificate whose dates are unknown: all but the last 0.01% of its lifetime. */
export const RENEW_NOW_WINDOW_RATIO = 0.9999;
/** How long a request stays in effect if no newer certificate appears. */
export const RENEWAL_TIMEOUT_MS = 15 * 60 * 1000;

type Pending = { requestedAt: number; ratio: number };
type Lifetime = { notBefore: string; notAfter: string };

/**
 * Keyed by name, then by the agent whose Caddy renews it ("" with no agent). Each agent settles
 * only its own entry from its own report, so one agent can't end another's renewal.
 */
const pending = new Map<string, Map<string, Pending>>();
const evicting = new Set<string>();

/** Test seam: forget every request. */
export function resetRenewals() {
  pending.clear();
}

/** Runs `load` with these names left out of Caddy's management, so they drop out of its cache. */
export async function withEviction(names: string[], load: () => Promise<void>) {
  for (const name of names) evicting.add(name.toLowerCase());
  try {
    await load();
  } finally {
    for (const name of names) evicting.delete(name.toLowerCase());
  }
}

export function evictedNames(): string[] {
  return [...evicting];
}

function prune(now: number) {
  for (const [name, agents] of pending) {
    for (const [agent, { requestedAt }] of agents) {
      if (now - requestedAt > RENEWAL_TIMEOUT_MS) agents.delete(agent);
    }
    if (agents.size === 0) pending.delete(name);
  }
}

/**
 * Opens at 90% of the current cert's age, so its replacement stays outside the window while the
 * request lasts. A fixed 0.9999 of a 5-year lifetime would still shut out the first 4 hours.
 */
export function renewNowRatio(current: Lifetime | null | undefined, now = Date.now()): number {
  const notBefore = Date.parse(current?.notBefore ?? "");
  const notAfter = Date.parse(current?.notAfter ?? "");
  const lifetime = notAfter - notBefore;
  if (!(lifetime > 0) || notAfter <= now || notBefore >= now) return RENEW_NOW_WINDOW_RATIO;
  // No floor: one above the cert's age would open the window after now, missing a fresh cert.
  return 1 - ((now - notBefore) * 0.9) / lifetime;
}

/** `targets`: each agent that serves the name, with the certificate it holds if known. */
export function requestRenewal(
  name: string,
  targets: { agent: string; current?: Lifetime | null }[],
  now = Date.now(),
) {
  const agents = new Map<string, Pending>();
  for (const { agent, current } of targets) {
    agents.set(agent, { requestedAt: now, ratio: renewNowRatio(current, now) });
  }
  if (agents.size > 0) pending.set(name.toLowerCase(), agents);
}

/** Names with any agent still renewing. */
export function renewalsPending(now = Date.now()): Map<string, ReadonlyMap<string, Pending>> {
  prune(now);
  return new Map(pending);
}

/** From one agent's own storage report. True when it finished any, so the caller reloads. */
export function settleRenewals(
  agent: string,
  certificates: { names: string[]; notBefore: string }[],
  now = Date.now(),
): boolean {
  prune(now);
  let settled = false;
  for (const [name, agents] of pending) {
    const entry = agents.get(agent);
    if (!entry) continue;
    const renewed = certificates.some(
      (cert) =>
        cert.names.some((n) => n.toLowerCase() === name) &&
        Date.parse(cert.notBefore) >= entry.requestedAt - 60_000,
    );
    if (!renewed) continue;
    agents.delete(agent);
    if (agents.size === 0) pending.delete(name);
    settled = true;
  }
  return settled;
}

type Policy = Record<string, unknown> & { subjects?: string[] };

/** Each pending name gets a copy of its policy: widening the original would renew every cert. */
export function withRenewalOverrides(
  policies: Policy[],
  agent: string,
  now = Date.now(),
): Policy[] {
  const names = new Map<string, Pending>();
  for (const [name, agents] of renewalsPending(now)) {
    const entry = agents.get(agent);
    if (entry) names.set(name, entry);
  }
  if (evicting.size > 0) {
    policies = policies
      .map((policy) =>
        policy.subjects
          ? { ...policy, subjects: policy.subjects.filter((s) => !evicting.has(s.toLowerCase())) }
          : policy,
      )
      .filter((policy) => !policy.subjects || policy.subjects.length > 0);
    for (const name of evicting) names.delete(name);
  }
  if (names.size === 0) return policies;
  const overrides: Policy[] = [];
  const rest = policies.map((policy) => {
    const subjects = policy.subjects ?? [];
    const renewing = subjects.filter((subject) => names.has(subject.toLowerCase()));
    if (renewing.length === 0) return policy;
    for (const subject of renewing) {
      overrides.push({
        ...policy,
        subjects: [subject],
        renewal_window_ratio: names.get(subject.toLowerCase())?.ratio,
      });
    }
    const remaining = subjects.filter((subject) => !names.has(subject.toLowerCase()));
    return { ...policy, subjects: remaining };
  });
  // A policy left with no subjects would match everything; drop it instead.
  return [...overrides, ...rest.filter((policy) => !policy.subjects || policy.subjects.length > 0)];
}
