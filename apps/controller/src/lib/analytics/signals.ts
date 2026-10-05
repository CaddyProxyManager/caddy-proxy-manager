/**
 * Traffic worth a look, found in ClickHouse: bursts of 5xx answers, spikes in mitigated requests,
 * and blocked traffic piling up on one path. Pure detection over query rows, under a time budget,
 * so a page that lists them (Needs attention, the host list) never waits on a slow query.
 */

import type { TrafficOutcome } from "@cpm/shared";
import {
  isAnalyticsEnabled,
  queryRows,
  timeFilter,
  timeParams,
  withQueryAbort,
} from "../clickhouse/client";
import { processMemo } from "../settings/process-memo";
import { PATH_SQL } from "../clickhouse/explore";
import type { TimeWindow } from "./explore-state";

/** A burst needs this many 5xx answers... */
export const BURST_MIN_ERRORS = 10;
/** ...making up at least this share of the requests in its minutes. */
export const BURST_MIN_SHARE = 0.1;
/** Minutes with errors this close together are one burst. */
export const BURST_JOIN_GAP_MINUTES = 2;
/** A burst with a 5xx this recent is still going on. */
export const BURST_ONGOING_SECONDS = 5 * 60;

export const SPIKE_MIN_MITIGATED = 50;
export const SPIKE_MIN_RATIO = 3;
export const SPIKE_BASELINE_SECONDS = 7 * 86400;

export const CONCENTRATION_MIN_REQUESTS = 50;
const CONCENTRATION_LIMIT = 50;

export const DEFAULT_SIGNAL_BUDGET_MS = 4000;
const DEFAULT_SIGNAL_WINDOW_SECONDS = 86400;
/** The Host header is the client's, so its groups are capped in count and in time. */
export const MAX_SIGNAL_WINDOW_SECONDS = 92 * 86400;
export const SIGNAL_GROUP_LIMIT = 10_000;

export type SignalSeverity = "critical" | "warning" | "info";

export type ServerErrorBurst = {
  kind: "serverErrorBurst";
  severity: SignalSeverity;
  host: string;
  /** Start of the first minute and end of the last. */
  from: number;
  to: number;
  errors: number;
  requests: number;
  share: number;
  ongoing: boolean;
};

export type MitigationSpike = {
  kind: "mitigationSpike";
  severity: SignalSeverity;
  /** Null for the whole fleet. */
  host: string | null;
  mitigated: number;
  /** The 7-day average for a window this long. */
  baseline: number;
  /** Null when the baseline was zero. */
  ratio: number | null;
};

export type BlockedConcentration = {
  kind: "blockedConcentration";
  severity: SignalSeverity;
  host: string;
  path: string;
  outcome: TrafficOutcome;
  requests: number;
};

export type TrafficSignal = ServerErrorBurst | MitigationSpike | BlockedConcentration;

export type TrafficSignals = {
  /** False when analytics are off: no signals is then "unknown", not "all clear". */
  available: boolean;
  window: TimeWindow;
  signals: TrafficSignal[];
  /** Detectors that ran out of budget or failed, by kind; their signals are missing. */
  skipped: TrafficSignal["kind"][];
};

// ── Detection (pure) ──────────────────────────────────────────────────────

export type MinuteErrors = { host: string; minute: number; requests: number; errors: number };

/** `minute` is a minute number (epoch seconds / 60). Rows need not be sorted. */
export function findServerErrorBursts(
  rows: readonly MinuteErrors[],
  now: number,
): ServerErrorBurst[] {
  const byHost = new Map<string, MinuteErrors[]>();
  for (const row of rows) {
    if (row.errors <= 0) continue;
    const list = byHost.get(row.host);
    if (list) list.push(row);
    else byHost.set(row.host, [row]);
  }

  const bursts: ServerErrorBurst[] = [];
  for (const [host, minutes] of byHost) {
    minutes.sort((a, b) => a.minute - b.minute);
    let run: MinuteErrors[] = [];
    const close = () => {
      if (run.length === 0) return;
      const errors = run.reduce((sum, row) => sum + row.errors, 0);
      const requests = run.reduce((sum, row) => sum + row.requests, 0);
      const share = requests > 0 ? errors / requests : 0;
      if (errors >= BURST_MIN_ERRORS && share >= BURST_MIN_SHARE) {
        const last = run[run.length - 1]!.minute;
        const ongoing = (last + 1) * 60 >= now - BURST_ONGOING_SECONDS;
        bursts.push({
          kind: "serverErrorBurst",
          severity: ongoing ? "critical" : "warning",
          host,
          from: run[0]!.minute * 60,
          to: (last + 1) * 60,
          errors,
          requests,
          share,
          ongoing,
        });
      }
      run = [];
    };
    for (const row of minutes) {
      const previous = run[run.length - 1];
      // A gap of two empty minutes still joins: the next minute is at most three later.
      if (previous && row.minute - previous.minute > BURST_JOIN_GAP_MINUTES + 1) close();
      run.push(row);
    }
    close();
  }
  return bursts.sort((a, b) => b.to - a.to);
}

export type MitigatedCount = { host: string; current: number; baseline: number };

/** `baseline` rows hold the count over the 7 days before the window, not an average. */
export function findMitigationSpikes(
  rows: readonly MitigatedCount[],
  windowSeconds: number,
): MitigationSpike[] {
  const scale = windowSeconds / SPIKE_BASELINE_SECONDS;
  const spike = (host: string | null, current: number, baselineTotal: number) => {
    const baseline = baselineTotal * scale;
    if (current < SPIKE_MIN_MITIGATED || current < SPIKE_MIN_RATIO * baseline) return null;
    return {
      kind: "mitigationSpike",
      severity: "warning",
      host,
      mitigated: current,
      baseline,
      ratio: baseline > 0 ? current / baseline : null,
    } satisfies MitigationSpike;
  };
  const fleet = spike(
    null,
    rows.reduce((sum, row) => sum + row.current, 0),
    rows.reduce((sum, row) => sum + row.baseline, 0),
  );
  const hosts = rows
    .map((row) => spike(row.host, row.current, row.baseline))
    .filter((found) => found !== null)
    .sort((a, b) => b.mitigated - a.mitigated);
  return fleet ? [fleet, ...hosts] : hosts;
}

// ── Queries ───────────────────────────────────────────────────────────────

async function minuteErrors(window: TimeWindow): Promise<MinuteErrors[]> {
  // Only minutes with an error: a month of busy minutes never leaves ClickHouse.
  const rows = await queryRows<Record<string, unknown>>(
    `
    SELECT host, intDiv(toUInt32(ts), 60) AS minute, count() AS requests,
           countIf(status >= 500) AS errors
    FROM traffic_events
    WHERE ${timeFilter()} AND host != ''
    GROUP BY host, minute
    HAVING errors > 0
    ORDER BY errors DESC
    LIMIT {p_limit:UInt32}
  `,
    { ...timeParams(window.from, window.to), p_limit: SIGNAL_GROUP_LIMIT },
  );
  return rows.map((row) => ({
    host: String(row.host),
    minute: Math.floor(Number(row.minute)),
    requests: Number(row.requests),
    errors: Number(row.errors),
  }));
}

async function mitigatedCounts(window: TimeWindow): Promise<MitigatedCount[]> {
  const baselineFrom = window.from - SPIKE_BASELINE_SECONDS;
  const rows = await queryRows<Record<string, unknown>>(
    `
    SELECT host,
           countIf(ts >= toDateTime({p_from:UInt32}) AND outcome != 'served') AS current,
           countIf(ts < toDateTime({p_from:UInt32}) AND outcome != 'served') AS baseline
    FROM traffic_events
    WHERE ts >= toDateTime({p_baseline:UInt32}) AND ts <= toDateTime({p_to:UInt32}) AND host != ''
    GROUP BY host
    ORDER BY current DESC, baseline DESC
    LIMIT {p_limit:UInt32}
  `,
    {
      ...timeParams(window.from, window.to),
      p_baseline: Math.max(0, baselineFrom),
      p_limit: SIGNAL_GROUP_LIMIT,
    },
  );
  return rows.map((row) => ({
    host: String(row.host),
    current: Number(row.current),
    baseline: Number(row.baseline),
  }));
}

async function concentrations(window: TimeWindow): Promise<BlockedConcentration[]> {
  const rows = await queryRows<Record<string, unknown>>(
    `
    SELECT host, ${PATH_SQL} AS path_key, outcome, count() AS requests
    FROM traffic_events
    WHERE ${timeFilter()} AND outcome != 'served'
    GROUP BY host, path_key, outcome
    HAVING requests >= {p_min:UInt32}
    ORDER BY requests DESC
    LIMIT {p_limit:UInt32}
  `,
    {
      ...timeParams(window.from, window.to),
      p_min: CONCENTRATION_MIN_REQUESTS,
      p_limit: CONCENTRATION_LIMIT,
    },
  );
  return rows.map((row) => ({
    kind: "blockedConcentration",
    severity: "info",
    host: String(row.host),
    path: String(row.path_key),
    outcome: String(row.outcome) as TrafficOutcome,
    requests: Number(row.requests),
  }));
}

const TIMED_OUT = Symbol("timed out");

function withinBudget<T>(
  work: Promise<T>,
  deadline: Promise<typeof TIMED_OUT>,
): Promise<T | typeof TIMED_OUT> {
  return Promise.race([work, deadline]).catch((error: unknown): typeof TIMED_OUT => {
    console.warn("[analytics] a traffic signal detector failed:", error);
    return TIMED_OUT;
  });
}

/** The host list, the overview and a host's page all ask within the same minute. */
const SIGNALS_MEMO_MS = 60_000;

/**
 * The last 24 hours by default. Detectors run in parallel; one still running at the budget is
 * reported in `skipped` rather than waited for, and its query cancelled. A complete answer is
 * held for a minute, keyed on the window to the minute.
 */
export async function detectTrafficSignals(
  options: { window?: TimeWindow; budgetMs?: number; now?: number } = {},
): Promise<TrafficSignals> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const asked = options.window ?? { from: now - DEFAULT_SIGNAL_WINDOW_SECONDS, to: now };
  const window = {
    from: Math.max(asked.from, asked.to - MAX_SIGNAL_WINDOW_SECONDS),
    to: asked.to,
  };
  if (!(await isAnalyticsEnabled().catch(() => false))) {
    return { available: false, window, signals: [], skipped: [] };
  }
  const minute = (seconds: number) => Math.floor(seconds / 60);
  return processMemo(
    `traffic-signals:${minute(window.from)}:${minute(window.to)}`,
    () => runDetectors(window, now, options.budgetMs ?? DEFAULT_SIGNAL_BUDGET_MS),
    { ttlMs: SIGNALS_MEMO_MS, keep: (found) => found.skipped.length === 0 },
  );
}

async function runDetectors(
  window: TimeWindow,
  now: number,
  budgetMs: number,
): Promise<TrafficSignals> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
      abort.abort();
    }, budgetMs);
  });
  const run = <T>(detect: () => Promise<T>) =>
    withinBudget(withQueryAbort(abort.signal, detect), deadline);
  try {
    const [errors, mitigated, piles] = await Promise.all([
      run(() => minuteErrors(window)),
      run(() => mitigatedCounts(window)),
      run(() => concentrations(window)),
    ]);
    const signals: TrafficSignal[] = [];
    const skipped: TrafficSignal["kind"][] = [];
    if (errors === TIMED_OUT) skipped.push("serverErrorBurst");
    else signals.push(...findServerErrorBursts(errors, now));
    if (mitigated === TIMED_OUT) skipped.push("mitigationSpike");
    else signals.push(...findMitigationSpikes(mitigated, window.to - window.from));
    if (piles === TIMED_OUT) skipped.push("blockedConcentration");
    else signals.push(...piles);
    return { available: true, window, signals, skipped };
  } finally {
    clearTimeout(timer);
  }
}
