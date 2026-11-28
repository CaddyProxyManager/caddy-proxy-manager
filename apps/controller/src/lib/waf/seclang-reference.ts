/**
 * The SecLang vocabulary as an editor offers it: canonical spellings over seclang.ts's lookup
 * sets, and the values an argument may take. Descriptions live in the catalog under
 * `seclang.reference.<kind>.<name>`, keyed by these names.
 */

import {
  ACTIONS,
  lookupTable,
  type ActionArgument,
  type ActionKind,
  OPERATORS,
  SELECTABLE_VARIABLES,
  TRANSFORMATIONS,
  VARIABLES,
} from "./seclang";

export type SeclangTermKind =
  | "directives"
  | "variables"
  | "operators"
  | "actions"
  | "transformations";

/** Allowed first, then the ones the directive policy flags as risky. */
export const SECLANG_DIRECTIVES = [
  "SecRule",
  "SecAction",
  "SecMarker",
  "SecDefaultAction",
  "SecRuleRemoveById",
  "SecRuleRemoveByTag",
  "SecRuleRemoveByMsg",
  "SecRuleUpdateTargetById",
  "SecRuleUpdateTargetByTag",
  "SecRuleUpdateActionById",
  "SecRuleEngine",
  "SecRequestBodyAccess",
  "SecResponseBodyAccess",
  "SecRequestBodyLimit",
  "SecRequestBodyInMemoryLimit",
  "SecRequestBodyLimitAction",
  "SecResponseBodyLimit",
  "SecResponseBodyMimeType",
  "SecAuditEngine",
  "SecComponentSignature",
] as const;

/** The four the directive policy sends without a word. */
export const ALLOWED_SECLANG_DIRECTIVES: ReadonlySet<string> = new Set([
  "SecRule",
  "SecAction",
  "SecMarker",
  "SecDefaultAction",
]);

/** Settings the policy also sends as written (BODY_LIMIT_DIRECTIVE in caddy.ts). */
export const ALLOWED_SETTING_DIRECTIVES: ReadonlySet<string> = new Set([
  "SecRequestBodyLimit",
  "SecRequestBodyInMemoryLimit",
  "SecRequestBodyLimitAction",
]);

export const SECLANG_VARIABLES: readonly string[] = [...VARIABLES].sort();

export function isSelectableVariable(name: string): boolean {
  return SELECTABLE_VARIABLES.has(name.toUpperCase());
}

export const SECLANG_OPERATORS: readonly string[] = [...OPERATORS].sort((a, b) =>
  a.localeCompare(b, "en"),
);

/** Operators whose argument is optional or ignored. */
export const ARGUMENTLESS_OPERATORS: ReadonlySet<string> = new Set([
  "detectSQLi",
  "detectXSS",
  "unconditionalMatch",
  "noMatch",
  "validateUrlEncoding",
  "validateUtf8Encoding",
  "geoLookup",
]);

/** Coraza registers actions lower-cased; these are the spellings the CRS and its docs use. */
const ACTION_SPELLING: Record<string, string> = lookupTable({
  skipafter: "skipAfter",
  multimatch: "multiMatch",
  expirevar: "expireVar",
});

export type SeclangActionSpec = {
  name: string;
  kind: ActionKind;
  argument: ActionArgument;
};

export const SECLANG_ACTIONS: readonly SeclangActionSpec[] = Object.entries(ACTIONS)
  .map(([key, spec]) => ({ name: ACTION_SPELLING[key] ?? key, ...spec }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));

export function actionSpec(name: string): SeclangActionSpec | undefined {
  const spec = ACTIONS[name.toLowerCase()];
  return spec && { name: ACTION_SPELLING[name.toLowerCase()] ?? name.toLowerCase(), ...spec };
}

/** Canonical spellings; the test holds them to TRANSFORMATIONS. */
export const SECLANG_TRANSFORMATIONS = [
  "base64Decode",
  "base64DecodeExt",
  "base64Encode",
  "cmdLine",
  "compressWhitespace",
  "cssDecode",
  "escapeSeqDecode",
  "hexDecode",
  "hexEncode",
  "htmlEntityDecode",
  "jsDecode",
  "length",
  "lowercase",
  "md5",
  "none",
  "normalisePath",
  "normalisePathWin",
  "normalizePath",
  "normalizePathWin",
  "removeComments",
  "removeCommentsChar",
  "removeNulls",
  "removeWhitespace",
  "replaceComments",
  "replaceNulls",
  "sha1",
  "trim",
  "trimLeft",
  "trimRight",
  "uppercase",
  "urlDecode",
  "urlDecodeUni",
  "urlEncode",
  "utf8toUnicode",
] as const;

export function isTransformation(name: string): boolean {
  return TRANSFORMATIONS.has(name.toLowerCase());
}

/** The CRS's spelling; Coraza accepts any case. */
export const SECLANG_SEVERITIES = [
  "CRITICAL",
  "ERROR",
  "WARNING",
  "NOTICE",
  "INFO",
  "DEBUG",
  "ALERT",
  "EMERGENCY",
] as const;

export const SECLANG_PHASES = ["1", "2", "3", "4", "5"] as const;

/** `ctl:` options, each completed with its `=`. */
export const SECLANG_CTL_OPTIONS = [
  "ruleRemoveById",
  "ruleRemoveByTag",
  "ruleRemoveByMsg",
  "ruleRemoveTargetById",
  "ruleRemoveTargetByTag",
  "ruleRemoveTargetByMsg",
  "ruleEngine",
  "requestBodyAccess",
  "requestBodyProcessor",
  "requestBodyLimit",
  "forceRequestBodyVariable",
  "responseBodyAccess",
  "responseBodyProcessor",
  "auditEngine",
  "auditLogParts",
] as const;

/** Fixed values some actions take, for a picker rather than a text field. */
export const ACTION_VALUES: Readonly<Record<string, readonly string[]>> = lookupTable({
  phase: SECLANG_PHASES,
  severity: SECLANG_SEVERITIES,
  t: SECLANG_TRANSFORMATIONS,
  allow: ["phase", "request"],
});

/** Values the commoner settings directives take. */
export const DIRECTIVE_VALUES: Readonly<Record<string, readonly string[]>> = lookupTable({
  secruleengine: ["On", "Off", "DetectionOnly"],
  secrequestbodyaccess: ["On", "Off"],
  secresponsebodyaccess: ["On", "Off"],
  secrequestbodylimitaction: ["Reject", "ProcessPartial"],
  secauditengine: ["On", "Off", "RelevantOnly"],
});

/** Keys worth offering after `REQUEST_HEADERS:`; any header name is valid. */
export const COMMON_REQUEST_HEADERS = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Content-Length",
  "Content-Type",
  "Cookie",
  "Host",
  "Origin",
  "Referer",
  "User-Agent",
  "X-Forwarded-For",
  "X-Real-IP",
  "X-Requested-With",
] as const;

/** The canonical spelling of `name` among `kind`, or null when SecLang has no such term. */
export function canonicalTerm(kind: SeclangTermKind, name: string): string | null {
  const lower = name.toLowerCase();
  switch (kind) {
    case "directives":
      return SECLANG_DIRECTIVES.find((d) => d.toLowerCase() === lower) ?? null;
    case "variables":
      return VARIABLES.has(name.toUpperCase()) ? name.toUpperCase() : null;
    case "operators":
      return OPERATORS.has(name) ? name : null;
    case "actions":
      return actionSpec(name)?.name ?? null;
    case "transformations":
      return SECLANG_TRANSFORMATIONS.find((t) => t.toLowerCase() === lower) ?? null;
  }
}

/** The catalog key under `seclang.reference.<kind>`: keys are camelCase, `REQUEST_URI` is not. */
export function referenceKey(name: string): string {
  if (name.includes("_") || name === name.toUpperCase()) {
    const [head = "", ...rest] = name.toLowerCase().split("_");
    return head + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  }
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** Every term an editor may describe, by kind. */
export const SECLANG_TERMS: Record<SeclangTermKind, readonly string[]> = {
  directives: SECLANG_DIRECTIVES,
  variables: SECLANG_VARIABLES,
  operators: SECLANG_OPERATORS,
  actions: SECLANG_ACTIONS.map((action) => action.name),
  transformations: SECLANG_TRANSFORMATIONS,
};

export type OperatorFamily =
  | "text"
  | "pattern"
  | "number"
  | "address"
  | "detection"
  | "validation"
  | "constant";

/** What kind of test each operator runs, for the tag beside it. */
export const OPERATOR_FAMILIES: Record<string, OperatorFamily> = lookupTable({
  beginsWith: "text",
  contains: "text",
  endsWith: "text",
  streq: "text",
  strmatch: "text",
  within: "text",
  pm: "text",
  pmf: "text",
  pmFromFile: "text",
  pmFromDataset: "text",
  rx: "pattern",
  restpath: "pattern",
  eq: "number",
  ge: "number",
  gt: "number",
  le: "number",
  lt: "number",
  ipMatch: "address",
  ipMatchF: "address",
  ipMatchFromFile: "address",
  ipMatchFromDataset: "address",
  geoLookup: "address",
  rbl: "address",
  detectSQLi: "detection",
  detectXSS: "detection",
  validateByteRange: "validation",
  validateNid: "validation",
  validateSchema: "validation",
  validateUrlEncoding: "validation",
  validateUtf8Encoding: "validation",
  inspectFile: "validation",
  unconditionalMatch: "constant",
  noMatch: "constant",
});
