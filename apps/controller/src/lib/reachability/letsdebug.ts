/**
 * Let's Debug checks HTTP-01 readiness from the public internet, which the controller can't see.
 * Only run when an administrator asks, per domain: it tells a third party the domain name.
 */

import { outboundAllowed } from "../offline";

const BASE = "https://letsdebug.net";
const POLL_MS = 2000;
const TOTAL_MS = 60_000;

export type LetsDebugProblem = { name: string; severity: string; explanation: string };
export type LetsDebugResult =
  | { state: "done"; problems: LetsDebugProblem[] }
  | { state: "unavailable" }
  | { state: "offline" };

export async function askLetsDebug(domain: string): Promise<LetsDebugResult> {
  if (!(await outboundAllowed("letsdebug"))) return { state: "offline" };
  const deadline = Date.now() + TOTAL_MS;
  try {
    const created = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ method: "http-01", domain }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!created.ok) return { state: "unavailable" };
    const { ID } = (await created.json()) as { ID?: number };
    if (!Number.isInteger(ID)) return { state: "unavailable" };

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const response = await fetch(`${BASE}/${encodeURIComponent(domain)}/${ID}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        status?: string;
        result?: { problems?: { name?: string; severity?: string; explanation?: string }[] };
      };
      if (body.status !== "Complete") continue;
      return {
        state: "done",
        problems: (body.result?.problems ?? []).map((problem) => ({
          name: String(problem.name ?? ""),
          severity: String(problem.severity ?? ""),
          explanation: String(problem.explanation ?? "").slice(0, 2000),
        })),
      };
    }
    return { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}
