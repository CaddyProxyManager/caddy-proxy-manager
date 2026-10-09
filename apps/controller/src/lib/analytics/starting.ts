import { isConnectionError } from "@/src/lib/errors/net-errors";

/**
 * After a restart the agent recreates ClickHouse only once the controller answers, so for a few
 * moments nothing listens on its port. Errors then are expected, and worded as a wait, not a fault.
 */
export const ANALYTICS_STARTUP_GRACE_MS = 3 * 60_000;

/** The `code` an analytics route answers with while ClickHouse is still coming up. */
export const ANALYTICS_STARTING = "ANALYTICS_STARTING";

export function analyticsStarting(error: unknown, uptimeMs = process.uptime() * 1000): boolean {
  return uptimeMs < ANALYTICS_STARTUP_GRACE_MS && isConnectionError(error);
}
