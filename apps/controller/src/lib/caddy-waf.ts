/** WAF handler builder and effective-config resolver, split from caddy.ts for unit testing. */
import type { WafSettings } from "./settings";
import type { WafHostConfig } from "./models/proxy-hosts";
import {
  type DomainError,
  type DomainErrorCode,
  domainError,
  domainErrorMessage,
} from "./domain-error";
import {
  type SeclangIssue,
  goTrimSpace,
  parseActions,
  seclangDirectives,
  seclangErrors,
  splitRuleDirective,
} from "./seclang";

// ---------------------------------------------------------------------------
// Request body limits
// ---------------------------------------------------------------------------

/**
 * Coraza refuses a request body limit above 1 GiB, and one out-of-range value makes Caddy reject
 * the ENTIRE config document, not just the offending host.
 */
export const CORAZA_MAX_BODY_LIMIT = 1_073_741_824; // 1 GiB

/** Below ~1 KiB the limit is meaningless and only serves to break uploads. */
export const CORAZA_MIN_BODY_LIMIT = 1_024;

/** Coraza's built-in default when no SecRequestBodyLimit directive is parsed. */
export const CORAZA_DEFAULT_BODY_LIMIT = 134_217_728; // 128 MiB

/**
 * The limits `@coraza.conf-recommended` sets when the CRS is on. The 12.5 MiB is why large uploads
 * (Nextcloud/Immich chunks) fail with the CRS enabled and work with it off.
 */
export const CRS_BODY_LIMIT = 13_107_200; // 12.5 MiB
export const CRS_IN_MEMORY_BODY_LIMIT = 131_072; // 128 KiB

export function isValidBodyLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CORAZA_MIN_BODY_LIMIT &&
    value <= CORAZA_MAX_BODY_LIMIT
  );
}

export function bodyLimitRangeMessage(label: string): string {
  return `${label} must be an integer between ${CORAZA_MIN_BODY_LIMIT} and ${CORAZA_MAX_BODY_LIMIT} bytes (1 GiB is Coraza's hard maximum)`;
}

/** Stored in bytes (what SecLang takes), asked for in MiB; finer values go in custom directives. */
export const BYTES_PER_MIB = 1_048_576;
export const MIN_BODY_LIMIT_MIB = 1;
export const MAX_BODY_LIMIT_MIB = CORAZA_MAX_BODY_LIMIT / BYTES_PER_MIB; // 1024

export function bytesToMib(bytes: number | undefined): string {
  return typeof bytes === "number" && bytes > 0 ? String(Math.round(bytes / BYTES_PER_MIB)) : "";
}

/** One message per field rather than a spliced label: not every language puts the field first. */
export type BodyLimitErrorCode = Extract<
  DomainErrorCode,
  | "wafRequestBodyLimitInvalid"
  | "wafInMemoryBodyLimitInvalid"
  | "hostWafRequestBodyLimitInvalid"
  | "hostWafInMemoryBodyLimitInvalid"
>;

/** Parses a MiB form field into bytes. Blank means "unset - inherit the default". */
export function parseBodyLimitMib(raw: unknown, errorCode: BodyLimitErrorCode): number | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const mib = Number(raw.trim());
  if (!Number.isInteger(mib) || mib < MIN_BODY_LIMIT_MIB || mib > MAX_BODY_LIMIT_MIB) {
    // Strings, not numbers: the catalog would format 1024 as "1,024".
    throw domainError(errorCode, {
      min: String(MIN_BODY_LIMIT_MIB),
      max: String(MAX_BODY_LIMIT_MIB),
    });
  }
  return mib * BYTES_PER_MIB;
}

const BODY_LIMIT_DIRECTIVE =
  /^(SecRequestBodyLimit|SecRequestBodyNoFilesLimit|SecRequestBodyInMemoryLimit)\s+(\d+)\s*$/i;
const BODY_LIMIT_ACTION_DIRECTIVE = /^SecRequestBodyLimitAction\s+(?:Reject|ProcessPartial)\s*$/i;

/**
 * First custom directive whose byte count Coraza would reject, so the user gets a precise error at
 * save time instead of an opaque "Caddy rejected configuration" later.
 */
export function findInvalidBodyLimitDirective(
  directives: string | null | undefined,
): string | null {
  if (!directives?.trim()) return null;
  for (const { text } of seclangDirectives(directives)) {
    if (!text) continue;
    const match = BODY_LIMIT_DIRECTIVE.exec(text);
    if (match && !isValidBodyLimit(Number(match[2]))) return text;
  }
  return null;
}

/** Why a custom SecLang line never reaches Caddy - a code, so the wording lives in the catalog. */
export type DroppedWafDirectiveReason =
  | "wafDirectiveDroppedInclude"
  | "wafDirectiveDroppedRuleMutation"
  | "wafDirectiveDroppedCtlRuleEngine"
  | "wafDirectiveDroppedSetenv"
  | "wafDirectiveDroppedFileOperator"
  | "wafDirectiveDroppedOperatorCase"
  | "wafDirectiveDroppedCrsDataFileUnknown"
  | "wafDirectiveDroppedCrsDataFileNeedsCrs"
  | "wafDirectiveDroppedUnparseable"
  | "wafDirectiveDroppedChainPart"
  | "wafDirectiveDroppedDuplicateId"
  | "wafDirectiveDroppedBodyLimit"
  | "wafDirectiveDroppedNotAllowed"
  | "wafDirectiveDroppedUnterminated";

export type DroppedWafDirective = {
  line: string;
  reason: DroppedWafDirectiveReason;
  /** Strings only: the catalog would format a rule id with digit grouping. */
  params?: Record<string, string>;
};

export type CustomDirectiveFilterOptions = {
  /**
   * Whether the handler loads the CRS, and with it the embedded `@owasp_crs/` files. Undefined
   * when the caller cannot know (a merge-mode host inheriting it); buildWafHandler decides then.
   */
  crsLoaded?: boolean;
  /**
   * What the handler reads before these lines: the global directives, for a merge-mode host.
   * Never reported, but their rule ids are taken and a chain they leave open continues here.
   */
  precedingDirectives?: string | null;
};

/** Allowed on their own; anything else is dropped. */
const ALLOWED_DIRECTIVE_PREFIXES = [
  /^SecRule\s/,
  /^SecAction\s/,
  /^SecMarker\s/,
  /^SecDefaultAction\s/,
];

/** SecRule* variants that are not a plain SecRule: they mutate or disable the engine. */
const BLOCKED_SEC_RULE_PREFIXES = [
  /^SecRuleEngine\s/i,
  /^SecRuleRemoveById\s/i,
  /^SecRuleRemoveByTag\s/i,
  /^SecRuleRemoveByMsg\s/i,
  /^SecRuleUpdateActionById\s/i,
  /^SecRuleUpdateTargetById\s/i,
];

/** Operators that read the container's files or run a program, negated or not. */
const FILE_OR_EXEC_OPERATOR =
  /@\s*(inspectFile|pmFromFile|pmf|ipMatchFromFile|ipMatchF|validateSchema)\b/gi;
/** The ones that may read a file of the embedded CRS instead, spelt as Coraza registers them. */
const CRS_DATA_OPERATORS = ["pmFromFile", "pmf", "ipMatchFromFile", "ipMatchF"];
const CRS_DATA_FILE_PREFIX = "@owasp_crs/";
/**
 * The *.data files under rules/@owasp_crs in coraza-coreruleset v4.25.0, which docker/caddy/go.mod
 * pins. With the CRS loaded Coraza serves `@owasp_crs/<name>` from it; a name it lacks fails the
 * load, and Caddy then refuses the whole config.
 */
const CRS_DATA_FILES = new Set(
  [
    "ai-critical-artifacts.data",
    "asp-dotnet-errors.data",
    "iis-errors.data",
    "java-classes.data",
    "lfi-os-files.data",
    "php-errors.data",
    "php-function-names-933150.data",
    "php-variables.data",
    "restricted-files.data",
    "restricted-upload.data",
    "ruby-errors.data",
    "scanners-user-agents.data",
    "sql-errors.data",
    "ssrf-no-scheme.data",
    "ssrf.data",
    "unix-shell-aliases.data",
    "unix-shell-builtins.data",
    "unix-shell.data",
    "web-shells-asp.data",
    "web-shells-php.data",
    "windows-powershell-commands.data",
  ].map((name) => `${CRS_DATA_FILE_PREFIX}${name}`),
);

// setenv calls os.Setenv on the Caddy process. Both are judged on the parsed action list; these
// are a second net over the raw text, allowing what Coraza trims (U+0085, which \s misses).
const SETENV_ACTION = /\bsetenv[\s\u0085]*:/i;
const CTL_RULE_ENGINE_ACTION = /ctl[\s\u0085]*:[\s\u0085'"\\]*ruleEngine/i;

/** What a pending `chain` attaches to. SecMarker adds a rule too, and ends the chain. */
const RULE_DIRECTIVE = /^Sec(?:Rule|Action)\s/i;
const MARKER_DIRECTIVE = /^SecMarker\s/i;
/** Directives whose action list Coraza parses; SecDefaultAction's joins every later rule. */
const ACTION_LIST_DIRECTIVE = /^Sec(?:Rule|Action|DefaultAction)\s/i;

type DropReason = Pick<DroppedWafDirective, "reason" | "params">;

function fileOperatorDropReason(
  text: string,
  options: CustomDirectiveFilterOptions,
): DropReason | null {
  // The whole text, msg included: an operator hidden anywhere is not worth telling apart.
  const matches = [...text.matchAll(FILE_OR_EXEC_OPERATOR)];
  if (matches.length === 0) return null;
  const generic: DropReason = {
    reason: "wafDirectiveDroppedFileOperator",
    params: { name: matches[0][1] },
  };
  if (matches.length > 1) return generic;
  const operator = splitRuleDirective(text)?.operator;
  if (!operator || !/^!?@/.test(operator)) return generic;
  // Cut as ParseOperator cuts it: at the first space, trimmed.
  const space = operator.indexOf(" ");
  const name = goTrimSpace(space < 0 ? operator : operator.slice(0, space)).replace(/^!?@/, "");
  const argument = space < 0 ? "" : goTrimSpace(operator.slice(space + 1));
  if (!argument.startsWith(CRS_DATA_FILE_PREFIX)) return generic;
  if (!CRS_DATA_OPERATORS.includes(name)) {
    // Coraza looks operators up case-sensitively, so `@pmfromfile` fails the whole config.
    const registered = CRS_DATA_OPERATORS.find((op) => op.toLowerCase() === name.toLowerCase());
    return registered
      ? { reason: "wafDirectiveDroppedOperatorCase", params: { name, registered } }
      : generic;
  }
  if (!CRS_DATA_FILES.has(argument)) {
    return { reason: "wafDirectiveDroppedCrsDataFileUnknown", params: { file: argument } };
  }
  if (options.crsLoaded === false) {
    return { reason: "wafDirectiveDroppedCrsDataFileNeedsCrs", params: { file: argument } };
  }
  return null;
}

/** Judged on the action list as Coraza parses it, so spacing or quoting cannot hide an action. */
function ruleActionsDropReason(text: string): DropReason | null {
  if (!ACTION_LIST_DIRECTIVE.test(text)) return null;
  const parts = splitRuleDirective(text);
  // Coraza refuses it too, and with it the whole config; and its actions cannot be checked.
  if (!parts) return { reason: "wafDirectiveDroppedUnparseable" };
  for (const { key, value } of parseActions(parts.actions).actions) {
    if (key === "setenv") return { reason: "wafDirectiveDroppedSetenv" };
    if (key === "ctl" && goTrimSpace(value).toLowerCase().startsWith("ruleengine")) {
      return { reason: "wafDirectiveDroppedCtlRuleEngine" };
    }
  }
  return null;
}

function directiveDropReason(
  text: string,
  options: CustomDirectiveFilterOptions,
): DropReason | null {
  // Include would read arbitrary files out of the container filesystem.
  if (/^Include\s/i.test(text)) return { reason: "wafDirectiveDroppedInclude" };
  // Out-of-range limits would make Caddy reject the whole config; validation reports them, this
  // is the net. SecRequestBodyNoFilesLimit parses but is not enforced (corazawaf/coraza#896).
  const bodyLimit = BODY_LIMIT_DIRECTIVE.exec(text);
  if (bodyLimit) {
    return isValidBodyLimit(Number(bodyLimit[2]))
      ? null
      : { reason: "wafDirectiveDroppedBodyLimit" };
  }
  if (BODY_LIMIT_ACTION_DIRECTIVE.test(text)) return null;
  // Before the generic allowlist, so the reason names the real objection.
  if (BLOCKED_SEC_RULE_PREFIXES.some((pattern) => pattern.test(text))) {
    return { reason: "wafDirectiveDroppedRuleMutation" };
  }
  if (!ALLOWED_DIRECTIVE_PREFIXES.some((pattern) => pattern.test(text))) {
    return { reason: "wafDirectiveDroppedNotAllowed" };
  }
  // ctl:ruleEngine inside an allowed rule can conditionally disable the WAF.
  if (CTL_RULE_ENGINE_ACTION.test(text)) return { reason: "wafDirectiveDroppedCtlRuleEngine" };
  if (SETENV_ACTION.test(text)) return { reason: "wafDirectiveDroppedSetenv" };
  return fileOperatorDropReason(text, options) ?? ruleActionsDropReason(text);
}

function hasChainAction(text: string): boolean {
  const parts = splitRuleDirective(text);
  // Coraza refuses it anyway; counting it chained takes the neighbouring rule down with it.
  if (!parts) return /(?:^|[\s",])chain\s*(?:[,"]|$)/i.test(text);
  return parseActions(parts.actions).actions.some(({ key }) => key === "chain");
}

/** The id a rule sets: strconv.Atoi, so `id:'09001'` is 9001, and the last id action wins. */
function ruleIdOf(text: string): number | null {
  const parts = splitRuleDirective(text);
  if (!parts) return null;
  let id: number | null = null;
  for (const { key, value } of parseActions(parts.actions).actions) {
    if (key !== "id" || !/^[+-]?\d+$/.test(value)) continue;
    const parsed = Number(value);
    id = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return id;
}

/** An unclosed directive's text as Coraza would start joining it, for the chain check. */
function openDirectiveText(lines: readonly string[]): string {
  return lines
    .map(goTrimSpace)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => (line.endsWith("\\") ? line.slice(0, -1) : line))
    .join("");
}

type IndexedDropped = DroppedWafDirective & { index: number };

/** filterCustomDirectives, with each line's index in `raw.split("\n")`. */
function filterDirectiveLines(
  raw: string | null | undefined,
  options: CustomDirectiveFilterOptions,
): { kept: { line: string; index: number }[]; dropped: IndexedDropped[] } {
  const kept: { line: string; index: number }[] = [];
  const dropped: IndexedDropped[] = [];
  if (!raw?.trim()) return { kept, dropped };

  const offset = raw.slice(0, raw.length - raw.trimStart().length).split("\n").length - 1;
  const directives = seclangDirectives(raw.trim());
  const shown = directives.map(({ text, lines }) => text ?? lines.join("\n").trim());
  const reasons: (DropReason | null)[] = directives.map(({ text }) => {
    if (text === "") return null;
    // A dangling `\` would join whatever CPM emits next - a preset, or SecRuleEngine - onto it.
    if (text === null) return { reason: "wafDirectiveDroppedUnterminated" };
    return directiveDropReason(text, options);
  });

  // A chain is one rule to Coraza: keeping part of it hands Coraza a different rule, or a child
  // with a disruptive action, which fails the whole config.
  const dropWith = (members: readonly number[]) => {
    const first = members.find((index) => reasons[index] !== null);
    if (first === undefined) return;
    for (const index of members) {
      reasons[index] ??= { reason: "wafDirectiveDroppedChainPart", params: { line: shown[first] } };
    }
  };
  const rules: number[][] = [];
  let chain: number[] | null = null;
  for (const [index, { text, lines }] of directives.entries()) {
    const ruleText = text ?? openDirectiveText(lines);
    if (MARKER_DIRECTIVE.test(ruleText)) {
      if (chain) dropWith(chain);
      chain = null;
      continue;
    }
    if (!RULE_DIRECTIVE.test(ruleText)) continue;
    const chained = hasChainAction(ruleText);
    if (chain) {
      chain.push(index);
      if (!chained) {
        dropWith(chain);
        chain = null;
      }
    } else {
      const rule = [index];
      rules.push(rule);
      if (chained) chain = rule;
    }
  }
  if (chain) dropWith(chain);

  // Coraza refuses an id already in its rule group, and Caddy then the whole config. Only kept
  // rules take one; a custom rule reusing a CRS id is not caught.
  const usedIds = new Set<number>();
  for (const rule of rules) {
    if (rule.some((index) => reasons[index] !== null)) continue;
    const id = ruleIdOf(directives[rule[0]].text ?? "");
    if (id === null) continue;
    if (!usedIds.has(id)) {
      usedIds.add(id);
      continue;
    }
    reasons[rule[0]] = { reason: "wafDirectiveDroppedDuplicateId", params: { id: String(id) } };
    dropWith(rule);
  }

  directives.forEach(({ lines, start }, i) => {
    const reason = reasons[i];
    if (reason === null) {
      lines.forEach((line, j) => {
        kept.push({ line, index: offset + start + j });
      });
    } else {
      dropped.push({ line: shown[i], ...reason, index: offset + start });
    }
  });
  return { kept, dropped };
}

/**
 * Splits custom directives into kept and dropped lines. The allowlist is the security boundary; a
 * silently dropped line reads as "the WAF ignores my rule", so validators name each one (#146).
 * A directive goes with its whole chain, and a rule reusing a kept rule's id goes too.
 */
export function filterCustomDirectives(
  raw: string | null | undefined,
  options: CustomDirectiveFilterOptions = {},
): { kept: string[]; dropped: DroppedWafDirective[] } {
  const preceding = options.precedingDirectives;
  // Joined as resolveEffectiveWaf merges them; `raw` starts at line `firstOwnLine`.
  const firstOwnLine = preceding && raw ? preceding.split("\n").length : 0;
  const { kept, dropped } = filterDirectiveLines(
    firstOwnLine > 0 ? `${preceding}\n${raw}` : raw,
    options,
  );
  return {
    kept: kept.filter(({ index }) => index >= firstOwnLine).map(({ line }) => line),
    dropped: dropped
      .filter(({ index }) => index >= firstOwnLine)
      .map(({ index: _index, ...entry }) => entry),
  };
}

function droppedReasonText(entry: DroppedWafDirective): string {
  // As strings, or the catalog formats 1073741824 with separators; other reasons ignore them.
  const bounds = { min: String(CORAZA_MIN_BODY_LIMIT), max: String(CORAZA_MAX_BODY_LIMIT) };
  return domainErrorMessage(entry.reason, { ...bounds, ...entry.params });
}

/** "line - why" for the validators' error; echoing only lines CPM drops repeats nothing new. */
export function droppedWafDirectiveDetails(dropped: readonly DroppedWafDirective[]): string[] {
  return dropped.map((entry) => `"${entry.line}" - ${droppedReasonText(entry)}`);
}

/** Which catalog entries a directive error uses: each names its own field. */
const DIRECTIVE_ERROR_CODES = {
  global: { bodyLimit: "wafDirectiveBodyLimitOutOfRange", dropped: "wafDirectivesDropped" },
  host: { bodyLimit: "hostWafDirectiveBodyLimitOutOfRange", dropped: "hostWafDirectivesDropped" },
  preset: {
    bodyLimit: "wafPresetDirectiveBodyLimitOutOfRange",
    dropped: "wafPresetDirectivesDropped",
  },
} as const satisfies Record<string, Record<"bodyLimit" | "dropped", DomainErrorCode>>;

export type PreviousCustomDirectives = {
  directives: string | null | undefined;
  options?: CustomDirectiveFilterOptions;
};

/**
 * The 400 for directives that would lose a line, or null. With `previous` (the stored value and
 * its options) only what this save newly drops counts: a stored rule a later release started
 * dropping must not block unrelated edits, and buildWafHandler still leaves it out and says so.
 */
export function customDirectivesError(
  directives: string | null | undefined,
  options: CustomDirectiveFilterOptions = {},
  previous?: PreviousCustomDirectives,
  subject: keyof typeof DIRECTIVE_ERROR_CODES = "global",
): DomainError | null {
  let { dropped } = filterCustomDirectives(directives, options);
  if (previous) {
    // Counted by text, so a second copy of a dropped line is still new.
    const alreadyDropped = new Map<string, number>();
    for (const { line } of filterCustomDirectives(previous.directives, previous.options).dropped) {
      alreadyDropped.set(line, (alreadyDropped.get(line) ?? 0) + 1);
    }
    dropped = dropped.filter(({ line }) => {
      const count = alreadyDropped.get(line) ?? 0;
      if (count > 0) alreadyDropped.set(line, count - 1);
      return count === 0;
    });
  }
  if (dropped.length === 0) return null;
  const codes = DIRECTIVE_ERROR_CODES[subject];
  // Safe to echo: it matched `<known directive name> <digits>`, never free-form text.
  const badBodyLimit = dropped.find(({ reason }) => reason === "wafDirectiveDroppedBodyLimit");
  if (badBodyLimit) {
    return domainError(
      codes.bodyLimit,
      {
        directive: badBodyLimit.line,
        min: String(CORAZA_MIN_BODY_LIMIT),
        max: String(CORAZA_MAX_BODY_LIMIT),
      },
      { status: 400 },
    );
  }
  return domainError(
    codes.dropped,
    { count: dropped.length, details: droppedWafDirectiveDetails(dropped) },
    { status: 400 },
  );
}

/** "line N: why" per linter issue, capped: one early typo can make every later line look wrong. */
export function seclangErrorDetails(issues: readonly SeclangIssue[], limit = 5): string[] {
  return issues.slice(0, limit).map((issue) =>
    domainErrorMessage("seclangIssueAt", {
      line: String(issue.line),
      reason: domainErrorMessage(issue.code, issue.params),
    }),
  );
}

/** Positive integers, deduplicated, in first-seen order - the order presets are emitted in. */
export function normalizeWafPresetIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((id): id is number => Number.isInteger(id) && (id as number) > 0)),
  ];
}

/** Same shape as preset ids; plugins are emitted in this order within each CRS slot. */
export const normalizeWafPluginIds = normalizeWafPresetIds;

// ---------------------------------------------------------------------------
// CRS plugins
// ---------------------------------------------------------------------------

export type CrsPluginRules = { config: string; before: string; after: string };

/** Why a CRS plugin file cannot be loaded - a code, so the sentence lives in the catalog. */
export type CrsPluginRejectionReason =
  | "crsPluginDirectiveNotAllowed"
  | "crsPluginNeedsFile"
  | "crsPluginCtlRuleEngine"
  | "crsPluginRuleIdOutOfRange"
  | "crsPluginPersistentCollection"
  | "crsPluginUnbalancedQuotes"
  | "crsPluginUnterminated"
  | "crsPluginInvalidSeclang";

export type CrsPluginRejection = {
  line: string;
  reason: CrsPluginRejectionReason;
  /** The linter's own reason, as a sentence, for `crsPluginInvalidSeclang`. */
  params?: { reason: string };
};

/**
 * Wider than the custom-directive allowlist: rewriting CRS rule targets from an -after file is what
 * an exclusion plugin is for.
 */
const PLUGIN_DIRECTIVE_PREFIXES = [
  /^SecRule\s/,
  /^SecAction\s/,
  /^SecMarker\s/,
  /^SecRuleRemoveBy(?:Id|Tag)\s/,
  /^SecRuleUpdateTargetBy(?:Id|Tag)\s/,
];

/** Operators that read a file next to the rule, which an inlined plugin does not have. */
const FILE_OPERATOR = /@(?:inspectFile|pmFromFile|pmf|ipMatchFromFile|ipMatchF|geoLookup)\b/i;

/** ModSecurity persistent collections; Coraza refuses to compile a rule that uses one. */
const PERSISTENT_COLLECTION =
  /^SecRule\s+(?:\S*\|)?[!&]*(?:IP|SESSION|USER|GLOBAL|RESOURCE)(?::|\s)|setvar\s*:\s*'?(?:ip|session|user|global|resource)\.|\binitcol\s*:/i;

/** Double quotes outside a backslash escape. An odd count is google-oauth2's unclosed action list. */
function hasUnbalancedQuotes(text: string): boolean {
  return (text.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1;
}

/** `id:123`, not `ctl:ruleRemoveById=123`: a rule's own id, the one the registry range bounds. */
const RULE_ID = /(?:^|[\s"',])id\s*:\s*'?(\d+)/g;

/**
 * Checked on store and again on emit: a plugin Coraza cannot compile, or a duplicate rule id
 * outside the registry range, takes the whole config down as Caddy loads it.
 */
export function findCrsPluginRejections(
  raw: string,
  range: { start: number; end: number },
): CrsPluginRejection[] {
  const rejections: CrsPluginRejection[] = [];
  const normalized = raw.replace(/\r\n?/g, "\n");
  /** So the linter does not name an already-refused directive a second time. */
  const rejectedStarts = new Set<number>();
  for (const { text, lines, start } of seclangDirectives(normalized)) {
    if (text === "") continue;
    const reason = pluginDirectiveRejection(text, range);
    if (!reason) continue;
    rejections.push({ line: text ?? lines.join("\n").trim(), reason });
    rejectedStarts.add(start);
  }
  const sourceLines = normalized.split("\n");
  for (const issue of seclangErrors(normalized)) {
    if (rejectedStarts.has(issue.line - 1)) continue;
    rejections.push({
      line: sourceLines[issue.line - 1].trim(),
      reason: "crsPluginInvalidSeclang",
      params: { reason: domainErrorMessage(issue.code, issue.params) },
    });
  }
  return rejections;
}

function pluginDirectiveRejection(
  text: string | null,
  range: { start: number; end: number },
): CrsPluginRejectionReason | null {
  if (text === null) return "crsPluginUnterminated";
  if (!PLUGIN_DIRECTIVE_PREFIXES.some((pattern) => pattern.test(text))) {
    return "crsPluginDirectiveNotAllowed";
  }
  if (FILE_OPERATOR.test(text)) return "crsPluginNeedsFile";
  if (/ctl\s*:\s*ruleEngine/i.test(text)) return "crsPluginCtlRuleEngine";
  if (PERSISTENT_COLLECTION.test(text)) return "crsPluginPersistentCollection";
  if (hasUnbalancedQuotes(text)) return "crsPluginUnbalancedQuotes";
  for (const match of text.matchAll(RULE_ID)) {
    const id = Number(match[1]);
    if (id < range.start || id > range.end) return "crsPluginRuleIdOutOfRange";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stored lines the config leaves out
// ---------------------------------------------------------------------------

export const GLOBAL_WAF_SOURCE = "global WAF settings";

/**
 * Where an effective config's custom directives come from: the global ones it starts with, then
 * the host's own, named by `label`. Build it with wafDirectiveSource.
 */
export type WafDirectiveSource = {
  label: string;
  globalDirectives: string | null;
  /** The global settings' own CRS state, which decides what they drop on their own. */
  globalCrsLoaded: boolean;
};

/**
 * `global`: the global settings drop the line on their own. `fromGlobal`: a global line only this
 * handler drops, because the host turns the CRS off or its first line breaks a global chain.
 */
type DroppedOrigin = "own" | "global" | "fromGlobal";

function droppedByOrigin(
  source: string | WafDirectiveSource,
  dropped: readonly IndexedDropped[],
): [DroppedOrigin, DroppedWafDirective[]][] {
  const strip = (entries: readonly IndexedDropped[]) =>
    entries.map(({ index: _index, ...entry }) => entry);
  if (typeof source === "string") return dropped.length > 0 ? [["own", strip(dropped)]] : [];
  const globalLines = source.globalDirectives ? source.globalDirectives.split("\n").length : 0;
  const droppedByGlobal = new Set(
    filterDirectiveLines(source.globalDirectives, {
      crsLoaded: source.globalCrsLoaded,
    }).dropped.map(({ index }) => index),
  );
  const groups: [DroppedOrigin, IndexedDropped[]][] = [
    ["global", dropped.filter(({ index }) => index < globalLines && droppedByGlobal.has(index))],
    [
      "fromGlobal",
      dropped.filter(({ index }) => index < globalLines && !droppedByGlobal.has(index)),
    ],
    ["own", dropped.filter(({ index }) => index >= globalLines)],
  ];
  return groups.filter(([, entries]) => entries.length > 0).map(([o, e]) => [o, strip(e)]);
}

function originLabel(source: string | WafDirectiveSource, origin: DroppedOrigin): string {
  const label = typeof source === "string" ? source : source.label;
  if (origin === "global") return GLOBAL_WAF_SOURCE;
  return origin === "fromGlobal" ? `${label}, from the ${GLOBAL_WAF_SOURCE}` : label;
}

// Once per source and content: config is rebuilt on every change, and a repeat would bury it.
const warnedDroppedDirectives = new Set<string>();

function warnDroppedDirectives(label: string, dropped: readonly DroppedWafDirective[]): void {
  const items = dropped.map((d) => `  "${d.line}" -> ${droppedReasonText(d)}`).join("\n");
  const key = `${label}\n${items}`;
  if (warnedDroppedDirectives.has(key)) return;
  if (warnedDroppedDirectives.size >= 1000) warnedDroppedDirectives.clear();
  warnedDroppedDirectives.add(key);
  console.warn(
    `[waf] ${label}: ${dropped.length} custom directive line(s) are not sent to Caddy and have no effect:\n${items}`,
  );
}

/** The global directives resolveEffectiveWaf(global, host) starts with, or null. */
function inheritedGlobalDirectives(
  global: WafSettings | null,
  host: WafHostConfig | null | undefined,
): string | null {
  if (!resolveEffectiveWaf(global, host) || host?.waf_mode === "override") return null;
  if (host && !global) return null;
  return global?.custom_directives || null;
}

export function wafDirectiveSource(
  global: WafSettings | null,
  host: WafHostConfig | null | undefined,
  label: string,
): WafDirectiveSource {
  return {
    label,
    globalDirectives: inheritedGlobalDirectives(global, host),
    globalCrsLoaded: Boolean(global?.load_owasp_crs),
  };
}

export type DroppedWafDirectiveReport = DroppedWafDirective & {
  origin: "global" | "host" | "hostFromGlobal";
  /** The proxy host, for `host` and `hostFromGlobal`. */
  host: { name: string; domains: string[] } | null;
};

/**
 * Stored lines the handlers built from these settings leave out. Saves refuse them, but a stored
 * value can predate a rule, and a left-out deny rule silently stops blocking.
 */
export function listDroppedWafDirectives(
  global: WafSettings | null,
  hosts: readonly { name: string; domains: readonly string[]; waf?: WafHostConfig | null }[],
): DroppedWafDirectiveReport[] {
  const reports = new Map<string, DroppedWafDirectiveReport>();
  const collect = (
    waf: WafSettings | null,
    source: string | WafDirectiveSource,
    host: DroppedWafDirectiveReport["host"],
  ) => {
    if (!waf?.enabled || waf.mode === "Off") return;
    const { dropped } = filterDirectiveLines(waf.custom_directives, {
      crsLoaded: Boolean(waf.load_owasp_crs),
    });
    for (const [origin, entries] of droppedByOrigin(source, dropped)) {
      for (const entry of entries) {
        const report: DroppedWafDirectiveReport =
          origin === "global" || host === null
            ? { ...entry, origin: "global", host: null }
            : { ...entry, origin: origin === "own" ? "host" : "hostFromGlobal", host };
        const key = JSON.stringify([report.origin, report.host?.name, entry.line, entry.reason]);
        reports.set(key, report);
      }
    }
  };
  collect(global, GLOBAL_WAF_SOURCE, null);
  for (const host of hosts) {
    collect(
      resolveEffectiveWaf(global, host.waf),
      wafDirectiveSource(global, host.waf, host.name),
      { name: host.name, domains: [...host.domains] },
    );
  }
  return [...reports.values()];
}

/**
 * Effective WAF settings for a host: null host → global as-is; `enabled === false` → opt out;
 * `waf_mode === "override"` → host only; `"merge"` (default) → host over global.
 */
export function resolveEffectiveWaf(
  global: WafSettings | null,
  host: WafHostConfig | null | undefined,
): WafSettings | null {
  const hostEnabled = host?.enabled;
  const globalEnabled = global?.enabled;

  if (!hostEnabled && !globalEnabled) return null;

  if (host && host.waf_mode === "override") {
    if (!hostEnabled) return null;
    return {
      enabled: true,
      mode: host.mode ?? "On",
      load_owasp_crs: host.load_owasp_crs ?? false,
      custom_directives: host.custom_directives ?? "",
      excluded_rule_ids: host.excluded_rule_ids,
      preset_ids: host.preset_ids,
      plugin_ids: host.plugin_ids,
      request_body_limit: host.request_body_limit,
      request_body_in_memory_limit: host.request_body_in_memory_limit,
      request_body_limit_action: host.request_body_limit_action,
    };
  }

  // host.enabled === false is an explicit opt-out, even when global is on.
  if (host && global) {
    if (host.enabled === false) return null;
    return {
      enabled: true,
      mode: host.mode ?? global.mode,
      load_owasp_crs: host.load_owasp_crs ?? global.load_owasp_crs,
      custom_directives: [global.custom_directives, host.custom_directives]
        .filter(Boolean)
        .join("\n"),
      excluded_rule_ids: [...(global.excluded_rule_ids ?? []), ...(host.excluded_rule_ids ?? [])],
      preset_ids: [...new Set([...(global.preset_ids ?? []), ...(host.preset_ids ?? [])])],
      plugin_ids: [...new Set([...(global.plugin_ids ?? []), ...(host.plugin_ids ?? [])])],
      request_body_limit: host.request_body_limit ?? global.request_body_limit,
      request_body_in_memory_limit:
        host.request_body_in_memory_limit ?? global.request_body_in_memory_limit,
      request_body_limit_action: host.request_body_limit_action ?? global.request_body_limit_action,
    };
  }

  if (host?.enabled) {
    return {
      enabled: true,
      mode: host.mode ?? "On",
      load_owasp_crs: host.load_owasp_crs ?? false,
      custom_directives: host.custom_directives ?? "",
      excluded_rule_ids: host.excluded_rule_ids,
      preset_ids: host.preset_ids,
      plugin_ids: host.plugin_ids,
      request_body_limit: host.request_body_limit,
      request_body_in_memory_limit: host.request_body_in_memory_limit,
      request_body_limit_action: host.request_body_limit_action,
    };
  }
  if (global?.enabled) return global;
  return null;
}

/** The token is case-insensitive, and HTTP/2's extended CONNECT carries no Upgrade header. */
export const WEBSOCKET_ATTEMPT_MATCHERS: Record<string, unknown>[] = [
  { header_regexp: { Upgrade: { pattern: "(?i)websocket" } } },
  { method: ["CONNECT"] },
];

/**
 * Builds the Caddy `waf` handler. @-prefixed SecLang paths resolve from the embedded
 * coraza-coreruleset filesystem, mounted only when `load_owasp_crs` is true - so every @-include
 * is gated on that flag, or the config load fails.
 */
export function buildWafHandler(
  waf: WafSettings,
  presets: ReadonlyMap<number, string> = new Map(),
  plugins: ReadonlyMap<number, CrsPluginRules> = new Map(),
  /** Names the dropped-directive warning; without one nothing is logged, as for a dry run. */
  source?: string | WafDirectiveSource,
): Record<string, unknown> {
  const parts: string[] = [];

  // Settings are stored unvalidated and `mode` is interpolated into SecLang, so clamp it to
  // Coraza's three values or it smuggles directives past the allowlist.
  const engineMode = waf.mode === "Off" || waf.mode === "DetectionOnly" ? waf.mode : "On";

  if (waf.load_owasp_crs) {
    parts.push("Include @coraza.conf-recommended", "Include @crs-setup.conf.example");
  }

  // CRS 4 order: every -config, every -before, the rules, every -after. Plugins only tune the CRS,
  // so without it they are left out; an unknown id is a stale selection and emits nothing.
  const selectedPlugins = waf.load_owasp_crs
    ? [...new Set(waf.plugin_ids ?? [])].flatMap((id) => plugins.get(id) ?? [])
    : [];
  const pluginPart = (file: keyof CrsPluginRules) => {
    for (const plugin of selectedPlugins) if (plugin[file].trim()) parts.push(plugin[file].trim());
  };
  pluginPart("config");
  pluginPart("before");

  // Ahead of the rules, since ctl:ruleRemove* only affects rules that have not run yet. An unknown
  // id is a stale selection and emits nothing.
  for (const id of new Set(waf.preset_ids ?? [])) {
    const { kept } = filterCustomDirectives(presets.get(id), { crsLoaded: waf.load_owasp_crs });
    if (kept.length > 0) parts.push(kept.join("\n"));
  }

  if (waf.load_owasp_crs) parts.push("Include @owasp_crs/*.conf");
  pluginPart("after");

  if (waf.excluded_rule_ids?.length) {
    const validIds = waf.excluded_rule_ids.filter(
      (id): id is number =>
        typeof id === "number" && Number.isFinite(id) && id > 0 && Number.isInteger(id),
    );
    if (validIds.length > 0) {
      parts.push(`SecRuleRemoveById ${validIds.join(" ")}`);
    }
  }

  parts.push(
    `SecRuleEngine ${engineMode}`,
    // Logs only transactions where a rule fired (CRS sets auditlog on all), avoiding huge logs.
    "SecAuditEngine RelevantOnly",
    "SecAuditLog /logs/waf-audit.log",
    "SecAuditLogFormat JSON",
    // The image pre-creates the log caddy-owned 0660 and Coraza keeps an existing file's mode, so
    // the agent can truncate it via caddy's group; SecAuditLogFileMode would lose group-write.
    // Bodies (I, J, E) and headers (D) are omitted to avoid huge writes.
    "SecAuditLogParts ABFHZ",
    "SecResponseBodyAccess Off",
  );

  // After the CRS include, to override its 12.5 MiB, and before custom_directives, which win.
  if (isValidBodyLimit(waf.request_body_limit)) {
    parts.push(`SecRequestBodyLimit ${waf.request_body_limit}`);
  }
  if (isValidBodyLimit(waf.request_body_in_memory_limit)) {
    parts.push(`SecRequestBodyInMemoryLimit ${waf.request_body_in_memory_limit}`);
  }
  if (
    waf.request_body_limit_action === "Reject" ||
    waf.request_body_limit_action === "ProcessPartial"
  ) {
    parts.push(`SecRequestBodyLimitAction ${waf.request_body_limit_action}`);
  }

  // Validators refuse writes that would drop a line; this is the net for older rows.
  const { kept, dropped } = filterDirectiveLines(waf.custom_directives, {
    crsLoaded: waf.load_owasp_crs,
  });
  if (source !== undefined) {
    for (const [origin, entries] of droppedByOrigin(source, dropped)) {
      warnDroppedDirectives(originLabel(source, origin), entries);
    }
  }
  if (kept.length > 0) {
    parts.push(kept.map(({ line }) => line).join("\n"));
  }

  const handler: Record<string, unknown> = {
    handler: "waf",
    directives: reconcileInMemoryBodyLimit(parts.join("\n"), waf.load_owasp_crs),
  };
  if (waf.load_owasp_crs) handler.load_owasp_crs = true;
  return handler;
}

/**
 * Coraza fails config load unless InMemoryLimit <= RequestBodyLimit, checking the last of each.
 * Lowering just the request limit leaves the CRS's 128 KiB above it, so append a corrective line.
 */
function reconcileInMemoryBodyLimit(directives: string, crsLoaded: boolean): string {
  let requestLimit = crsLoaded ? CRS_BODY_LIMIT : CORAZA_DEFAULT_BODY_LIMIT;
  let inMemoryLimit = crsLoaded ? CRS_IN_MEMORY_BODY_LIMIT : null;

  for (const line of directives.split("\n")) {
    const match = BODY_LIMIT_DIRECTIVE.exec(line.trim());
    if (!match) continue;
    const name = match[1].toLowerCase();
    const value = Number(match[2]);
    if (name === "secrequestbodylimit") requestLimit = value;
    else if (name === "secrequestbodyinmemorylimit") inMemoryLimit = value;
  }

  if (inMemoryLimit === null || inMemoryLimit <= requestLimit) return directives;
  return `${directives}\nSecRequestBodyInMemoryLimit ${requestLimit}`;
}
