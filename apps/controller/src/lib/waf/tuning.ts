/**
 * CRS tuning: the paranoia level and the anomaly thresholds. Client safe. Emitted only where a
 * value differs from the CRS default, so an untuned WAF builds exactly as it always has.
 */

export const PARANOIA_LEVELS = [1, 2, 3, 4] as const;
export type ParanoiaLevel = (typeof PARANOIA_LEVELS)[number];

export const DEFAULT_PARANOIA_LEVEL: ParanoiaLevel = 1;
export const DEFAULT_INBOUND_THRESHOLD = 5;
export const DEFAULT_OUTBOUND_THRESHOLD = 4;
export const MIN_ANOMALY_THRESHOLD = 1;
export const MAX_ANOMALY_THRESHOLD = 10_000;

/** The CRS's default points per matched rule, by the severity the rule logs. */
export const SEVERITY_POINTS: Record<string, number> = {
  CRITICAL: 5,
  ERROR: 4,
  WARNING: 3,
  NOTICE: 2,
};

export type WafTuning = {
  paranoia_level?: number;
  /** Also run the next level's rules, logging without adding to the blocking score. */
  log_next_paranoia_level?: boolean;
  inbound_anomaly_threshold?: number;
  outbound_anomaly_threshold?: number;
};

export function isParanoiaLevel(value: unknown): value is ParanoiaLevel {
  return (PARANOIA_LEVELS as readonly unknown[]).includes(value);
}

export function isAnomalyThreshold(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_ANOMALY_THRESHOLD &&
    value <= MAX_ANOMALY_THRESHOLD
  );
}

/** What the WAF runs with, defaults filled in; a stored value out of range reads as the default. */
export function effectiveTuning(tuning: WafTuning | null | undefined): {
  paranoiaLevel: ParanoiaLevel;
  detectionParanoiaLevel: ParanoiaLevel;
  inboundThreshold: number;
  outboundThreshold: number;
} {
  const paranoiaLevel = isParanoiaLevel(tuning?.paranoia_level)
    ? tuning.paranoia_level
    : DEFAULT_PARANOIA_LEVEL;
  const next = tuning?.log_next_paranoia_level ? Math.min(paranoiaLevel + 1, 4) : paranoiaLevel;
  return {
    paranoiaLevel,
    detectionParanoiaLevel: next as ParanoiaLevel,
    inboundThreshold: isAnomalyThreshold(tuning?.inbound_anomaly_threshold)
      ? tuning.inbound_anomaly_threshold
      : DEFAULT_INBOUND_THRESHOLD,
    outboundThreshold: isAnomalyThreshold(tuning?.outbound_anomaly_threshold)
      ? tuning.outbound_anomaly_threshold
      : DEFAULT_OUTBOUND_THRESHOLD,
  };
}

/**
 * The SecActions crs-setup.conf.example leaves commented out, under the ids it reserves for them.
 * Placed after that file and before the rules, whose initialisation only fills what is unset.
 */
export function crsTuningDirectives(tuning: WafTuning | null | undefined): string[] {
  const { paranoiaLevel, detectionParanoiaLevel, inboundThreshold, outboundThreshold } =
    effectiveTuning(tuning);
  const action = (id: number, setvars: string[]) =>
    `SecAction "id:${id},phase:1,pass,t:none,nolog,tag:'OWASP_CRS',${setvars.join(",")}"`;
  const out: string[] = [];
  if (paranoiaLevel !== DEFAULT_PARANOIA_LEVEL) {
    out.push(action(900000, [`setvar:tx.blocking_paranoia_level=${paranoiaLevel}`]));
  }
  if (detectionParanoiaLevel !== paranoiaLevel) {
    out.push(action(900001, [`setvar:tx.detection_paranoia_level=${detectionParanoiaLevel}`]));
  }
  if (
    inboundThreshold !== DEFAULT_INBOUND_THRESHOLD ||
    outboundThreshold !== DEFAULT_OUTBOUND_THRESHOLD
  ) {
    out.push(
      action(900110, [
        `setvar:tx.inbound_anomaly_score_threshold=${inboundThreshold}`,
        `setvar:tx.outbound_anomaly_score_threshold=${outboundThreshold}`,
      ]),
    );
  }
  return out;
}

/** The rule set docker/caddy/go.mod pins (coraza-coreruleset); a unit test holds them together. */
export const CRS_VERSION = "4.25.0";
