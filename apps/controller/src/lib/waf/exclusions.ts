/**
 * Scoped WAF exclusions: a rule switched off everywhere, on one host, under one path, for one
 * variable, or for one client range. Client safe: the form normalises a path the way the save does.
 */

/** The anomaly-score decisions: excluding one turns the CRS's blocking off altogether. */
export const PROTECTED_RULE_IDS: readonly number[] = [949110, 949111, 959100, 959101];

/** Far above every range a rule set registers, so a generated id never meets a real rule. */
export const WAF_EXCLUSION_RULE_ID_BASE = 1_900_000_000;

/** The dashboard host's id in a rule's proxyHostId; the same value as DASHBOARD_HOST_ID. */
export const DASHBOARD_EXCLUSION_HOST_ID = -1;

/**
 * What the dashboard cannot work without, so no one can remove it and it is not stored. 920420
 * refuses the content types the app's own POSTs (server actions, uploads) are sent with. The ids
 * sit apart from the stored serial, which the generated rule ids are built from.
 */
export const DASHBOARD_MANDATORY_EXCLUSIONS: readonly WafExclusionRule[] = [
  {
    id: 200_000_001,
    ruleId: 920420,
    proxyHostId: DASHBOARD_EXCLUSION_HOST_ID,
    path: null,
    target: null,
    clientIp: null,
  },
];

/** The exclusions a dashboard handler applies: its own and the global ones, plus the mandatory. */
export function dashboardExclusions(
  exclusions: readonly WafExclusionRule[],
  overridesGlobal = false,
): WafExclusionRule[] {
  return [
    ...exclusionsFor(exclusions, DASHBOARD_EXCLUSION_HOST_ID, overridesGlobal),
    ...DASHBOARD_MANDATORY_EXCLUSIONS,
  ];
}

const MAX_RULE_ID = 2_147_483_647;
const MAX_EXCLUSION_PATH = 512;
const MAX_EXCLUSION_REASON = 500;

/** What the config build needs of an exclusion. */
export type WafExclusionRule = {
  id: number;
  ruleId: number;
  proxyHostId: number | null;
  path: string | null;
  target: string | null;
  /** An address or CIDR range REMOTE_ADDR must match. */
  clientIp: string | null;
};

type ExclusionErrorCode =
  | "wafExclusionRuleIdInvalid"
  | "wafExclusionRuleProtected"
  | "wafExclusionPathInvalid"
  | "wafExclusionTargetInvalid"
  | "wafExclusionClientIpInvalid"
  | "wafExclusionReasonTooLong";

export class ExclusionInputError extends Error {
  constructor(readonly code: ExclusionErrorCode) {
    super(code);
    this.name = "ExclusionInputError";
  }
}

export function validateExclusionRuleId(value: unknown): number {
  const id = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > MAX_RULE_ID) {
    throw new ExclusionInputError("wafExclusionRuleIdInvalid");
  }
  if (PROTECTED_RULE_IDS.includes(id)) throw new ExclusionInputError("wafExclusionRuleProtected");
  return id;
}

/**
 * Decoded once, as Go hands Coraza the path, then dot-segments and repeated slashes resolved as
 * `t:normalisePath` resolves them at match time. A trailing `*` makes it a prefix.
 */
export function normalizeExclusionPath(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ExclusionInputError("wafExclusionPathInvalid");
  let value = raw.trim();
  if (!value) return null;
  // A path pasted from an event carries its query, which REQUEST_FILENAME never has.
  value = value.replace(/[?#].*$/s, "");
  const prefix = value.endsWith("*");
  if (prefix) value = value.slice(0, -1);
  try {
    value = decodeURIComponent(value);
  } catch {
    throw new ExclusionInputError("wafExclusionPathInvalid");
  }
  if (!value.startsWith("/")) throw new ExclusionInputError("wafExclusionPathInvalid");
  // Inside a quoted operator: a quote or backslash ends it, whitespace splits it, %{ is a macro.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\s"\\\u0000-\u001f\u007f*]|%\{/.test(value)) {
    throw new ExclusionInputError("wafExclusionPathInvalid");
  }
  const trailingSlash = value.length > 1 && value.endsWith("/");
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  let normalized = `/${segments.join("/")}`;
  if (trailingSlash && normalized !== "/") normalized += "/";
  if (prefix) normalized += "*";
  if (normalized.length > MAX_EXCLUSION_PATH) {
    throw new ExclusionInputError("wafExclusionPathInvalid");
  }
  return normalized;
}

/**
 * A stored path as the save left it. Not re-normalised, since it is already decoded and a `%` in
 * it would not decode twice; only what could leave the quoted operator is refused.
 */
export function checkStoredExclusionPath(path: string | null): string | null {
  if (path === null || path === "") return null;
  const body = path.endsWith("*") ? path.slice(0, -1) : path;
  if (
    typeof path !== "string" ||
    !body.startsWith("/") ||
    path.length > MAX_EXCLUSION_PATH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
    /[\s"\\\u0000-\u001f\u007f*]|%\{/.test(body)
  ) {
    throw new ExclusionInputError("wafExclusionPathInvalid");
  }
  return path;
}

/** Collections a request rule can be told to skip; a key never holds what ends an action list. */
const TARGET_COLLECTIONS = [
  "ARGS",
  "ARGS_GET",
  "ARGS_POST",
  "ARGS_NAMES",
  "ARGS_GET_NAMES",
  "ARGS_POST_NAMES",
  "REQUEST_COOKIES",
  "REQUEST_COOKIES_NAMES",
  "REQUEST_HEADERS",
  "REQUEST_HEADERS_NAMES",
  "REQUEST_BODY",
  "REQUEST_URI",
  "REQUEST_URI_RAW",
  "REQUEST_FILENAME",
  "REQUEST_BASENAME",
  "REQUEST_LINE",
  "QUERY_STRING",
  "FILES",
  "FILES_NAMES",
  "XML",
] as const;
const TARGET = /^([A-Za-z_]+)(?::([A-Za-z0-9_.\-[\]]{1,128}))?$/;

export function normalizeExclusionTarget(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ExclusionInputError("wafExclusionTargetInvalid");
  const value = raw.trim();
  if (!value) return null;
  const match = TARGET.exec(value);
  const collection = match?.[1]?.toUpperCase();
  if (!match || !(TARGET_COLLECTIONS as readonly string[]).includes(collection ?? "")) {
    throw new ExclusionInputError("wafExclusionTargetInvalid");
  }
  return match[2] ? `${collection}:${match[2]}` : (collection as string);
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/** Without node:net, which the form's bundle has no polyfill for; zone ids are refused. */
function isIpv6(text: string): boolean {
  if (!text.includes(":") || !/^[0-9a-f:.]+$/.test(text)) return false;
  let body = text;
  const tail = text.slice(text.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    if (!IPV4.test(tail)) return false;
    body = `${text.slice(0, text.length - tail.length)}0:0`;
  }
  const halves = body.split("::");
  if (halves.length > 2) return false;
  const groups = halves.map((half) => (half === "" ? [] : half.split(":")));
  if (!groups.flat().every((group) => IPV6_GROUP.test(group))) return false;
  const count = groups.flat().length;
  return halves.length === 1 ? count === 8 : count <= 7;
}

/**
 * One IPv4 or IPv6 address, or a CIDR range of either; a full-length prefix is the bare address.
 * Only hex digits, dots, colons and a slash survive, so it never leaves the quoted operator.
 */
export function normalizeExclusionClientIp(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ExclusionInputError("wafExclusionClientIpInvalid");
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const [address, prefix, ...rest] = value.split("/");
  const bits = IPV4.test(address) ? 32 : isIpv6(address) ? 128 : 0;
  if (bits === 0 || rest.length > 0) throw new ExclusionInputError("wafExclusionClientIpInvalid");
  if (prefix === undefined) return address;
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > bits) {
    throw new ExclusionInputError("wafExclusionClientIpInvalid");
  }
  return Number(prefix) === bits ? address : `${address}/${Number(prefix)}`;
}

export function normalizeExclusionReason(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length > MAX_EXCLUSION_REASON) {
    throw new ExclusionInputError("wafExclusionReasonTooLong");
  }
  return value;
}

/**
 * The exclusions a handler applies: every global one, and the host's own. A host overriding the
 * global WAF takes nothing global from it, its exclusions included, as rule-id lists never did.
 */
export function exclusionsFor(
  exclusions: readonly WafExclusionRule[],
  proxyHostId: number | null,
  overridesGlobal = false,
): WafExclusionRule[] {
  return exclusions.filter((exclusion) =>
    exclusion.proxyHostId === null
      ? !overridesGlobal
      : proxyHostId !== null && exclusion.proxyHostId === proxyHostId,
  );
}

/**
 * `removeIds` load-time removals, placed after the CRS as excluded_rule_ids always were; `rules`
 * runtime `ctl`s, placed before the rules they narrow, since a ctl only reaches rules still to run.
 */
export function exclusionDirectives(exclusions: readonly WafExclusionRule[]): {
  removeIds: number[];
  rules: string[];
} {
  const removeIds: number[] = [];
  const rules: string[] = [];
  const sorted = [...exclusions].sort((a, b) => a.id - b.id);
  for (const stored of sorted) {
    // Checked again here: an import or a restore writes rows without the save path's checks.
    let exclusion: WafExclusionRule;
    try {
      exclusion = {
        ...stored,
        ruleId: validateExclusionRuleId(stored.ruleId),
        path: checkStoredExclusionPath(stored.path),
        target: normalizeExclusionTarget(stored.target),
        clientIp: normalizeExclusionClientIp(stored.clientIp),
      };
    } catch {
      console.warn(`[waf] skipped exclusion ${stored.id}: it is not a valid exclusion`);
      continue;
    }
    const ctl = exclusion.target
      ? `ctl:ruleRemoveTargetById=${exclusion.ruleId};${exclusion.target}`
      : `ctl:ruleRemoveById=${exclusion.ruleId}`;
    const meta = `id:${WAF_EXCLUSION_RULE_ID_BASE + exclusion.id},phase:1,pass,t:none,nolog`;
    const pathOperator = exclusion.path?.endsWith("*")
      ? `@beginsWith ${exclusion.path.slice(0, -1)}`
      : exclusion.path
        ? `@streq ${exclusion.path}`
        : null;
    const pathRule = (actions: string) =>
      `SecRule REQUEST_FILENAME "${pathOperator}" "${actions.replace("t:none", "t:none,t:normalisePath")}"`;
    if (exclusion.clientIp) {
      // The ctl sits in the last link, so it runs only once the whole chain has matched.
      const ipRule = `SecRule REMOTE_ADDR "@ipMatch ${exclusion.clientIp}"`;
      rules.push(
        pathOperator
          ? [`${ipRule} "${meta},chain"`, `  ${pathRule(`t:none,${ctl}`)}`].join("\n")
          : `${ipRule} "${meta},${ctl}"`,
      );
    } else if (pathOperator) {
      rules.push(pathRule(`${meta},${ctl}`));
    } else if (exclusion.target) {
      rules.push(`SecAction "${meta},${ctl}"`);
    } else {
      removeIds.push(exclusion.ruleId);
    }
  }
  return { removeIds: [...new Set(removeIds)], rules };
}
