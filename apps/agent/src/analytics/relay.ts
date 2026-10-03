/**
 * Relayed through the controller so no agent holds a ClickHouse credential or needs to reach it,
 * and each row records its agent. One request per 30-second parser batch.
 */

import {
  type AgentAnalyticsKind,
  MAX_ANALYTICS_REQUEST_BYTES,
  type TrafficEventRow,
  type UpstreamErrorRow,
  type WafEventRow,
} from "@cpm/shared";
import type { ControllerClient } from "../controller-client";

export type AnalyticsSink = { client: ControllerClient; secret: string };

/** Headroom under the controller's cap for the GraphQL document around the rows. */
const ENVELOPE_BYTES = 4 * 1024;

let sink: AnalyticsSink | null = null;
let analyticsOn = false;
let upstreamErrorsOn = false;

/** Traffic and WAF events: everything below is a no-op for them when it is off. */
export function analyticsEnabled(): boolean {
  return sink !== null && analyticsOn;
}

/** The upstream error counts, which the controller may want with analytics off. */
export function upstreamErrorsEnabled(): boolean {
  return sink !== null && upstreamErrorsOn;
}

/** A sink alone is analytics, as before upstream error counts existed. */
export function configureAnalytics(
  next: AnalyticsSink | null,
  wanted: { analytics: boolean; upstreamErrors: boolean } = {
    analytics: next !== null,
    upstreamErrors: false,
  },
): void {
  const analytics = next !== null && wanted.analytics;
  if (next && analytics && !analyticsEnabled()) {
    console.log(`[analytics] relaying events to ${next.client.controllerUrl}`);
  }
  if (!analytics && analyticsEnabled()) console.log("[analytics] disabled by the controller");
  sink = next;
  analyticsOn = analytics;
  upstreamErrorsOn = next !== null && wanted.upstreamErrors;
}

/** A row that can never fit is dropped and counted, or the parser would never get past it. */
export function chunkBySize<T>(
  rows: readonly T[],
  maxBytes: number,
): { chunks: T[][]; oversized: number } {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  let oversized = 0;
  for (const row of rows) {
    // +1 for the comma.
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > maxBytes) {
      oversized += 1;
      continue;
    }
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, oversized };
}

/** Throws on any refusal, so the parser keeps its place and resends next pass. */
async function relay(kind: AgentAnalyticsKind, rows: readonly unknown[]): Promise<void> {
  const target = sink;
  if (!target || rows.length === 0) return;
  if (kind === "upstream-errors" ? !upstreamErrorsOn : !analyticsOn) return;

  const { chunks, oversized } = chunkBySize(rows, MAX_ANALYTICS_REQUEST_BYTES - ENVELOPE_BYTES);
  if (oversized > 0) {
    console.warn(`[analytics] dropped ${oversized} ${kind} event(s) too large to send`);
  }
  for (const chunk of chunks) {
    const { rejected } = await target.client.postAnalytics(target.secret, kind, chunk);
    if (rejected > 0) {
      console.warn(`[analytics] the controller refused ${rejected} malformed ${kind} event(s)`);
    }
  }
}

export function relayTrafficEvents(rows: TrafficEventRow[]): Promise<void> {
  return relay("traffic", rows);
}

export function relayWafEvents(rows: WafEventRow[]): Promise<void> {
  return relay("waf", rows);
}

export function relayUpstreamErrors(rows: UpstreamErrorRow[]): Promise<void> {
  return relay("upstream-errors", rows);
}
