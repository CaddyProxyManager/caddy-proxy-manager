/**
 * A configuration Caddy refused, told once until one loads again. An unreachable Caddy is left
 * out: that is an agent or a container down, which the agent watch tells about, and a fresh stack
 * applies before its agent has started Caddy at all.
 */

import { CaddyApplyError } from "../caddy-apply-error";
import { openProblemKeys, raiseProblem, resolveProblem } from "./index";

const PREFIX = "caddy-apply:";

type Target = { agentId: string; name: string } | null;

export async function reportApplyFailure(
  target: Target,
  error: unknown,
  now = Date.now(),
): Promise<void> {
  if (!(error instanceof CaddyApplyError) || error.code === "CADDY_UNREACHABLE") return;
  await raiseProblem(
    `${PREFIX}${target?.agentId ?? "all"}`,
    { kind: "caddyApplyFailed", agent: target?.name ?? null, error: error.message },
    now,
  );
}

/** A whole-fleet apply clears every refusal; one agent's clears only its own. */
export async function reportApplySuccess(target: Target, now = Date.now()): Promise<void> {
  const keys = target ? [`${PREFIX}${target.agentId}`] : await openProblemKeys(PREFIX);
  for (const key of keys) {
    await resolveProblem(
      key,
      (raised) =>
        raised?.kind === "caddyApplyFailed"
          ? { kind: "caddyApplyRecovered", agent: raised.agent }
          : null,
      now,
    );
  }
}
