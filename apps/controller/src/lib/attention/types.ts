/**
 * Needs attention, as data: each item is a code and its values, rendered from
 * `attention.items.<code>` in the reader's language, so no provider builds a sentence. Client safe.
 */

export const ATTENTION_SEVERITIES = ["critical", "warning", "info"] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

export const ATTENTION_PROVIDERS = [
  "certificates",
  "caddyApply",
  "agents",
  "traffic",
  "ldap",
  "accounts",
  "l4Ports",
  "crsPlugins",
  "geoip",
] as const;
export type AttentionProviderId = (typeof ATTENTION_PROVIDERS)[number];

export const ATTENTION_CODES = [
  "certificateExpired",
  "certificateExpiring",
  "certificateFileError",
  "caddyApplyFailed",
  "agentOffline",
  "agentProblem",
  "serverErrorBurst",
  "serverErrorShare",
  "mitigationSpike",
  "mitigationSpikeFleet",
  "blockedConcentration",
  "ldapUnreachable",
  "accountLocked",
  "accountDisabled",
  "l4PortsPending",
  "l4PortsFailed",
  "crsPluginDisabled",
  "geoipFailing",
] as const;
export type AttentionCode = (typeof ATTENTION_CODES)[number];

export type AttentionValues = Record<string, string | number>;

/** Who may see an item. Neither set: administrators only. */
export type AttentionScope = { proxyHosts?: number[]; agent?: number };

export type AttentionItem = {
  /** Stable across loads, e.g. `certificate:12`. */
  id: string;
  provider: AttentionProviderId;
  code: AttentionCode;
  severity: AttentionSeverity;
  values: AttentionValues;
  /** Where to fix it; null when there is no page for it. */
  href: string | null;
  /** When it started or was last seen, if known. */
  at: string | null;
  scope: AttentionScope;
};

export type AttentionList = {
  items: AttentionItem[];
  /** Providers that ran past their budget or failed: their items are missing, not cleared. */
  skipped: AttentionProviderId[];
  /** Items dropped past the cap. */
  truncated: number;
};

export const ATTENTION_LIMIT = 50;
export const ATTENTION_PROVIDER_BUDGET_MS = 4000;

const RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Worst first, then newest; items with no time last within their severity. */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const bySeverity = RANK[a.severity] - RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (b.at ?? "").localeCompare(a.at ?? "");
  });
}

export function worstSeverity(items: readonly AttentionItem[]): AttentionSeverity | null {
  return sortAttention(items)[0]?.severity ?? null;
}

/** ISO strings under these names are rendered as dates by the catalog's ICU arguments. */
const DATE_VALUES = new Set(["date", "since", "until", "from", "to"]);

/** An item's values as the catalog's ICU arguments take them: dates as Dates. */
export function attentionMessageValues(
  item: Pick<AttentionItem, "values">,
): Record<string, string | number | Date> {
  return Object.fromEntries(
    Object.entries(item.values).map(([key, value]) => [
      key,
      DATE_VALUES.has(key) && typeof value === "string" && Number.isFinite(Date.parse(value))
        ? new Date(value)
        : value,
    ]),
  );
}
