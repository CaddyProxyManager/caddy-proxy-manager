/**
 * The last configuration Caddy refused, per agent, until one loads again: what Needs attention
 * shows. Stored, so a restart does not forget a refusal nobody has fixed. An unreachable Caddy is
 * left out, as the notifications leave it out: that is an agent down, reported as one.
 */

import { CaddyApplyError } from "./apply-error";

const STATE_KEY = "caddy_apply_failures";

export type ApplyFailure = {
  /** The agent's name, or null for a whole-fleet apply. */
  agent: string | null;
  error: string;
  at: string;
};

/** Keyed by agentId, or "all" for a whole-fleet apply. */
export type ApplyFailures = Record<string, ApplyFailure>;

let chain: Promise<unknown> = Promise.resolve();

async function update(change: (state: ApplyFailures) => ApplyFailures | null): Promise<void> {
  const work = async () => {
    const [{ getSetting, setSetting }, { outsideStagingScope }] = await Promise.all([
      import("../settings"),
      import("../settings/staging-context"),
    ]);
    // Bookkeeping, not configuration: never part of a staged change set.
    await outsideStagingScope(async () => {
      const next = change((await getSetting<ApplyFailures>(STATE_KEY)) ?? {});
      if (next) await setSetting(STATE_KEY, next);
    });
  };
  const next = chain.then(work, work);
  chain = next.catch(() => {});
  await next.catch((error: unknown) => {
    console.error("[caddy] could not record the apply outcome:", error);
  });
}

export function recordApplyFailure(
  target: { agentId: string; name: string } | null,
  error: unknown,
  now = Date.now(),
): Promise<void> {
  if (!(error instanceof CaddyApplyError) || error.code === "CADDY_UNREACHABLE") {
    return Promise.resolve();
  }
  // A fleet apply refused by one agent is that agent's: its card shows it, and its next success
  // clears it. "all" is left for a Caddy reached with no agent attached.
  const agent = target ?? error.agent;
  return update((state) => ({
    ...state,
    [agent?.agentId ?? "all"]: {
      agent: agent?.name ?? null,
      error: error.message,
      at: new Date(now).toISOString(),
    },
  }));
}

/** A whole-fleet apply clears every refusal; one agent's clears only its own. */
export function recordApplySuccess(target: { agentId: string } | null): Promise<void> {
  return update((state) => {
    if (Object.keys(state).length === 0) return null;
    if (!target) return {};
    if (!(target.agentId in state)) return null;
    const { [target.agentId]: _cleared, ...rest } = state;
    return rest;
  });
}

export async function getApplyFailures(): Promise<ApplyFailures> {
  const [{ getSetting }, { outsideStagingScope }] = await Promise.all([
    import("../settings"),
    import("../settings/staging-context"),
  ]);
  return (await outsideStagingScope(() => getSetting<ApplyFailures>(STATE_KEY))) ?? {};
}
