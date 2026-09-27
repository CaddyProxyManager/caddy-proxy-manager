/**
 * SecLang read the way Coraza v3.7 reads it, pure so editors and validators lint the same text.
 * Errors are only what Coraza's parser raises - a false positive blocks a save Caddy would accept -
 * so anything less certain is a warning, and what this cannot know is left to the dry run.
 */

/**
 * `text` is what Coraza evaluates, `lines` the source it came from, `start` the first's 0-based
 * index; `text` is "" for blank/comment lines and null for an unclosed continuation or block.
 */
export type SeclangDirective = { text: string | null; lines: string[]; start: number };

/**
 * Groups lines as Coraza's parser.go does (`\` continues, backtick blocks, comments skipped even
 * mid-rule), so the allowlist judges what Coraza evaluates, not a split rule in pieces.
 */
export function seclangDirectives(raw: string): SeclangDirective[] {
  const out: SeclangDirective[] = [];
  let buffer = "";
  let pending: string[] = [];
  let pendingStart = 0;
  let inBackticks = false;
  raw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      if (pending.length > 0) pending.push(line);
      else out.push({ text: "", lines: [line], start: index });
      return;
    }
    if (pending.length === 0) pendingStart = index;
    pending.push(line);
    if (!inBackticks && trimmed.endsWith("`")) inBackticks = true;
    else if (inBackticks && trimmed.startsWith("`")) inBackticks = false;
    if (inBackticks) {
      buffer += `${trimmed}\n`;
      return;
    }
    if (trimmed.endsWith("\\")) {
      buffer += trimmed.slice(0, -1);
      return;
    }
    out.push({ text: buffer + trimmed, lines: pending, start: pendingStart });
    buffer = "";
    pending = [];
  });
  if (pending.length > 0) out.push({ text: null, lines: pending, start: pendingStart });
  return out;
}

// ---------------------------------------------------------------------------
// What Coraza v3.7 knows. Re-check these against its source when bumping it in docker/caddy.
// ---------------------------------------------------------------------------

/** Looked up case-insensitively (variables.Parse upper-cases). */
const VARIABLES = new Set(
  "ARGS ARGS_COMBINED_SIZE ARGS_GET ARGS_GET_NAMES ARGS_NAMES ARGS_PATH ARGS_POST ARGS_POST_NAMES AUTH_TYPE DURATION ENV FILES FILES_COMBINED_SIZE FILES_NAMES FILES_SIZES FILES_TMP_CONTENT FILES_TMPNAMES FULL_REQUEST FULL_REQUEST_LENGTH GEO HIGHEST_SEVERITY INBOUND_DATA_ERROR IP JSON MATCHED_VAR MATCHED_VAR_NAME MATCHED_VARS MATCHED_VARS_NAMES MULTIPART_BOUNDARY_QUOTED MULTIPART_BOUNDARY_WHITESPACE MULTIPART_CRLF_LF_LINES MULTIPART_DATA_AFTER MULTIPART_DATA_BEFORE MULTIPART_FILE_LIMIT_EXCEEDED MULTIPART_FILENAME MULTIPART_HEADER_FOLDING MULTIPART_INVALID_HEADER_FOLDING MULTIPART_INVALID_PART MULTIPART_INVALID_QUOTING MULTIPART_LF_LINE MULTIPART_MISSING_SEMICOLON MULTIPART_NAME MULTIPART_PART_HEADERS MULTIPART_STRICT_ERROR MULTIPART_UNMATCHED_BOUNDARY OUTBOUND_DATA_ERROR PATH_INFO QUERY_STRING REMOTE_ADDR REMOTE_HOST REMOTE_PORT REQBODY_ERROR REQBODY_ERROR_MSG REQBODY_PROCESSOR REQBODY_PROCESSOR_ERROR REQBODY_PROCESSOR_ERROR_MSG REQUEST_BASENAME REQUEST_BODY REQUEST_BODY_LENGTH REQUEST_COOKIES REQUEST_COOKIES_NAMES REQUEST_FILENAME REQUEST_HEADERS REQUEST_HEADERS_NAMES REQUEST_LINE REQUEST_METHOD REQUEST_PROTOCOL REQUEST_URI REQUEST_URI_RAW REQUEST_XML RES_BODY_ERROR RES_BODY_ERROR_MSG RES_BODY_PROCESSOR RES_BODY_PROCESSOR_ERROR RES_BODY_PROCESSOR_ERROR_MSG RESPONSE_ARGS RESPONSE_BODY RESPONSE_CONTENT_LENGTH RESPONSE_CONTENT_TYPE RESPONSE_HEADERS RESPONSE_HEADERS_NAMES RESPONSE_PROTOCOL RESPONSE_STATUS RESPONSE_XML RULE SERVER_ADDR SERVER_NAME SERVER_PORT SESSIONID STATUS_LINE TIME TIME_DAY TIME_EPOCH TIME_HOUR TIME_MIN TIME_MON TIME_SEC TIME_WDAY TIME_YEAR TX UNIQUE_ID UNKNOWN URLENCODED_ERROR USERID XML".split(
    " ",
  ),
);

/** Collections that take a `:key` (RuleVariable.CanBeSelected). */
const SELECTABLE_VARIABLES = new Set(
  "ARGS ARGS_GET ARGS_GET_NAMES ARGS_NAMES ARGS_PATH ARGS_POST ARGS_POST_NAMES ENV FILES FILES_NAMES FILES_SIZES FILES_TMP_CONTENT FILES_TMPNAMES GEO JSON MATCHED_VARS MATCHED_VARS_NAMES MULTIPART_FILENAME MULTIPART_NAME MULTIPART_PART_HEADERS REQUEST_COOKIES REQUEST_COOKIES_NAMES REQUEST_HEADERS REQUEST_HEADERS_NAMES REQUEST_XML RESPONSE_ARGS RESPONSE_HEADERS RESPONSE_HEADERS_NAMES RESPONSE_XML RULE TX XML".split(
    " ",
  ),
);

/** Case-sensitive: operators.Get is a plain map lookup. */
const OPERATORS = new Set(
  "beginsWith contains detectSQLi detectXSS endsWith eq ge geoLookup gt inspectFile ipMatch ipMatchF ipMatchFromDataset ipMatchFromFile le lt noMatch pm pmf pmFromDataset pmFromFile rbl restpath rx streq strmatch unconditionalMatch validateByteRange validateNid validateSchema validateUrlEncoding validateUtf8Encoding within".split(
    " ",
  ),
);

type ActionKind = "disruptive" | "metadata" | "flow" | "data" | "nondisruptive";
type ActionArgument = "none" | "required" | "optional";

/** Lower-cased, as actions.Register stores them. */
const ACTIONS: Record<string, { kind: ActionKind; argument: ActionArgument }> = {
  allow: { kind: "disruptive", argument: "optional" },
  auditlog: { kind: "nondisruptive", argument: "none" },
  block: { kind: "disruptive", argument: "none" },
  capture: { kind: "nondisruptive", argument: "none" },
  chain: { kind: "flow", argument: "none" },
  ctl: { kind: "nondisruptive", argument: "optional" },
  deny: { kind: "disruptive", argument: "none" },
  drop: { kind: "disruptive", argument: "none" },
  exec: { kind: "nondisruptive", argument: "none" },
  expirevar: { kind: "nondisruptive", argument: "optional" },
  id: { kind: "metadata", argument: "required" },
  initcol: { kind: "nondisruptive", argument: "optional" },
  log: { kind: "nondisruptive", argument: "none" },
  logdata: { kind: "nondisruptive", argument: "required" },
  maturity: { kind: "metadata", argument: "optional" },
  msg: { kind: "metadata", argument: "required" },
  multimatch: { kind: "nondisruptive", argument: "none" },
  noauditlog: { kind: "nondisruptive", argument: "none" },
  nolog: { kind: "nondisruptive", argument: "none" },
  pass: { kind: "disruptive", argument: "none" },
  phase: { kind: "metadata", argument: "required" },
  redirect: { kind: "disruptive", argument: "required" },
  rev: { kind: "metadata", argument: "required" },
  setenv: { kind: "nondisruptive", argument: "required" },
  setvar: { kind: "nondisruptive", argument: "required" },
  severity: { kind: "metadata", argument: "required" },
  skip: { kind: "flow", argument: "required" },
  skipafter: { kind: "flow", argument: "required" },
  status: { kind: "data", argument: "required" },
  t: { kind: "nondisruptive", argument: "required" },
  tag: { kind: "metadata", argument: "required" },
  ver: { kind: "metadata", argument: "required" },
};

/** Lower-cased, as transformations.Register stores them. `none` is special-cased by `t` itself. */
const TRANSFORMATIONS = new Set(
  "base64decode base64decodeext base64encode cmdline compresswhitespace cssdecode escapeseqdecode hexdecode hexencode htmlentitydecode jsdecode length lowercase md5 none normalisepath normalisepathwin normalizepath normalizepathwin removecomments removecommentschar removenulls removewhitespace replacecomments replacenulls sha1 uppercase urldecode urldecodeuni urlencode utf8tounicode trim trimleft trimright".split(
    " ",
  ),
);

const SEVERITIES = new Set([
  "emergency",
  "alert",
  "critical",
  "error",
  "warning",
  "notice",
  "info",
  "debug",
]);

/** The ids the CRS reserves for itself. A custom rule there collides with one sooner or later. */
const CRS_ID_RANGE = { start: 900_000, end: 999_999 };

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/** Error (will not load) or warning (may not behave as written); a code, worded in the catalog. */
export type SeclangIssueCode =
  | "seclangEmptyDirective"
  | "seclangRuleFormat"
  | "seclangUnknownVariable"
  | "seclangNotSelectable"
  | "seclangUnknownOperator"
  | "seclangUnsupportedRegex"
  | "seclangUnknownAction"
  | "seclangActionNeedsArgument"
  | "seclangActionTakesNoArgument"
  | "seclangInvalidActionArgument"
  | "seclangInvalidId"
  | "seclangDuplicateId"
  | "seclangUnknownTransformation"
  | "seclangSetvarNotTx"
  | "seclangChainDisruptive"
  | "seclangDefaultActionNeedsPhase"
  | "seclangDefaultActionNeedsDisruptive"
  | "seclangDefaultActionMetadata"
  | "seclangDefaultActionTransformation"
  | "seclangDefaultActionDuplicatePhase"
  | "seclangMissingId"
  | "seclangCrsIdRange"
  | "seclangDanglingChain"
  | "seclangUnclosedActionQuote";

export type SeclangIssueSeverity = "error" | "warning";

export type SeclangIssue = {
  /** 1-based, counting every line of the input as the editor numbers them. */
  line: number;
  severity: SeclangIssueSeverity;
  code: SeclangIssueCode;
  /** Strings only: the catalog would format a rule id with digit grouping. */
  params: Record<string, string>;
};

export type SeclangLintOptions = {
  /** Whether the CRS loads alongside this text, which makes its id range and defaults matter. */
  crsLoaded?: boolean;
};

type ParsedAction = { key: string; value: string };

/** Splits an action list the way parseActions does: commas outside single quotes, `\` escaping. */
function parseActions(actions: string): { actions: ParsedAction[]; unclosedQuote: boolean } {
  const out: ParsedAction[] = [];
  let beforeKey = -1;
  let afterKey = -1;
  let inQuotes = false;
  const push = (end: number) => {
    const hasValue = afterKey !== -1;
    const keyEnd = hasValue ? afterKey : end;
    const key = actions
      .slice(beforeKey + 1, keyEnd)
      .trim()
      .toLowerCase();
    let value = hasValue ? actions.slice(afterKey + 1, end).trim() : "";
    if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) value = value.slice(1, -1);
    out.push({ key, value });
  };
  // From 1, as Coraza does: a leading character can never close a key.
  for (let i = 1; i < actions.length; i++) {
    const c = actions[i];
    if (actions[i - 1] === "\\") continue;
    if (c === "'") {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (c === ":" && afterKey === -1) afterKey = i;
    else if (c === ",") {
      push(i);
      beforeKey = i;
      afterKey = -1;
    }
  }
  push(actions.length);
  return { actions: out, unclosedQuote: inQuotes };
}

/** Coraza's quoted-string cut: the first `"` not preceded by an odd run of backslashes. */
function cutQuoted(s: string): { quoted: string; rest: string } | null {
  if (s[0] !== '"') return null;
  let escapes = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== '"') {
      escapes = s[i] === "\\" ? escapes + 1 : 0;
      continue;
    }
    if (escapes % 2 === 1) {
      escapes = 0;
      continue;
    }
    return { quoted: s.slice(0, i + 1), rest: s.slice(i + 1) };
  }
  return null;
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** SecRule's three parts, or null where parseActionOperator refuses the line. */
function splitRule(data: string): { vars: string; operator: string; actions: string } | null {
  const trimmed = data.replace(/^ +| +$/g, "");
  const space = trimmed.indexOf(" ");
  if (space === -1) return null;
  const vars = trimmed.slice(0, space);
  const afterVars = trimmed.slice(space + 1).replace(/^ +/, "");
  const cut = cutQuoted(afterVars);
  if (!cut) return null;
  const rest = cut.rest.replace(/^ +/, "");
  if (rest.length === 0) return { vars, operator: stripQuotes(cut.quoted), actions: "" };
  if (rest.length < 2 || rest[0] !== '"' || !rest.endsWith('"')) return null;
  return { vars, operator: stripQuotes(cut.quoted), actions: stripQuotes(rest) };
}

/**
 * Variable names and whether each selects a key, following ParseVariables: `|` separates outside a
 * `/regex/` key, `!` and `&` prefix, `:` starts the key.
 */
function parseVariables(vars: string): { name: string; selected: boolean }[] {
  const out: { name: string; selected: boolean }[] = [];
  let state: "name" | "key" | "regex" | "quoted" = "name";
  let name = "";
  let escaped = false;
  for (let i = 0; i < vars.length; i++) {
    const c = vars[i];
    if (state === "regex") {
      if (c === "/" && !escaped) state = "key";
      escaped = c === "\\" ? !escaped : false;
      continue;
    }
    if (state === "quoted") {
      if (c === "'") state = "key";
      continue;
    }
    if (c === "|") {
      out.push({ name, selected: state === "key" });
      name = "";
      state = "name";
      continue;
    }
    if (state === "name") {
      if (c === ":") state = "key";
      else if (c !== "!" && c !== "&") name += c;
    } else if (c === "/" && vars[i - 1] === ":") state = "regex";
    else if (c === "'" && vars[i - 1] === ":") state = "quoted";
  }
  out.push({ name, selected: state !== "name" });
  return out.filter((v) => v.name !== "");
}

/**
 * First PCRE-only construct, or null: @rx compiles with RE2, which refuses lookaround,
 * backreferences, atomic groups and possessive quantifiers common in pasted ModSecurity rules.
 */
export function findUnsupportedRegex(pattern: string): string | null {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!inClass && /[1-9]/.test(next)) return `\\${next}`;
      if (!inClass && (next === "Z" || next === "G")) return `\\${next}`;
      if (!inClass && next === "k" && pattern[i + 2] === "<") return "\\k<";
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      // A leading `]` (or `^]`) is a literal member, not the close.
      if (pattern[i + 1] === "^") i++;
      if (pattern[i + 1] === "]") i++;
      continue;
    }
    if (c === "(" && pattern[i + 1] === "?") {
      const group = pattern.slice(i, i + 4);
      for (const construct of ["(?<=", "(?<!", "(?=", "(?!", "(?>", "(?("]) {
        if (group.startsWith(construct)) return construct;
      }
    }
    // `(?` opens a group, so its `?` is not a quantifier.
    const quantifier = c === "*" || c === "+" || (c === "?" && pattern[i - 1] !== "(") || c === "}";
    if (quantifier && pattern[i + 1] === "+") return `${c}+`;
  }
  return null;
}

type RuleContext = {
  /** Params carry names and values, never the whole rule. */
  report: (
    severity: SeclangIssueSeverity,
    code: SeclangIssueCode,
    params?: Record<string, string>,
  ) => void;
};

const INTEGER = /^[+-]?\d+$/;

function checkActions(
  raw: string,
  ctx: RuleContext,
): { id: number | null; chain: boolean; disruptive: boolean; parsed: ParsedAction[] } {
  // A SecRule may leave its actions out entirely, and Coraza then skips parsing them.
  if (raw === "") return { id: null, chain: false, disruptive: false, parsed: [] };
  const { actions, unclosedQuote } = parseActions(raw);
  if (unclosedQuote) ctx.report("warning", "seclangUnclosedActionQuote");
  let id: number | null = null;
  let chain = false;
  let disruptive = false;
  for (const { key, value } of actions) {
    const spec = ACTIONS[key];
    if (!spec) {
      ctx.report("error", "seclangUnknownAction", { name: key });
      continue;
    }
    if (spec.argument === "none" && value !== "") {
      ctx.report("error", "seclangActionTakesNoArgument", { name: key });
      continue;
    }
    if (spec.argument === "required" && value === "") {
      ctx.report("error", "seclangActionNeedsArgument", { name: key });
      continue;
    }
    if (spec.kind === "disruptive") disruptive = true;
    switch (key) {
      case "id": {
        const n = INTEGER.test(value) ? Number(value) : Number.NaN;
        if (!Number.isSafeInteger(n) || n <= 0) {
          ctx.report("error", "seclangInvalidId", { value });
          break;
        }
        id = n;
        break;
      }
      case "chain":
        chain = true;
        break;
      case "phase":
        if (!/^(?:request|response|logging|[+]?0*[1-5])$/.test(value)) {
          ctx.report("error", "seclangInvalidActionArgument", { name: key, value });
        }
        break;
      case "allow":
        if (value !== "" && value !== "phase" && value !== "request") {
          ctx.report("error", "seclangInvalidActionArgument", { name: key, value });
        }
        break;
      case "status":
        if (!INTEGER.test(value))
          ctx.report("error", "seclangInvalidActionArgument", { name: key, value });
        break;
      case "skip":
        if (!INTEGER.test(value) || Number(value) < 1) {
          ctx.report("error", "seclangInvalidActionArgument", { name: key, value });
        }
        break;
      case "maturity":
        if (!INTEGER.test(value) || Number(value) < 1 || Number(value) > 9) {
          ctx.report("error", "seclangInvalidActionArgument", { name: key, value });
        }
        break;
      case "severity":
        if (!SEVERITIES.has(value.toLowerCase()) && !(value.length === 1 && /[0-7]/.test(value))) {
          ctx.report("error", "seclangInvalidActionArgument", { name: key, value });
        }
        break;
      case "t":
        if (!TRANSFORMATIONS.has(value.toLowerCase())) {
          ctx.report("error", "seclangUnknownTransformation", { name: value });
        }
        break;
      case "setvar": {
        const target = value.startsWith("!") ? value.slice(1) : value;
        const key = target.split("=")[0];
        const dot = key.indexOf(".");
        const collection = dot === -1 ? key : key.slice(0, dot);
        if (collection.toUpperCase() !== "TX" || dot === -1 || !key.slice(dot + 1).trim()) {
          ctx.report("error", "seclangSetvarNotTx", { value });
        }
        break;
      }
    }
  }
  return { id, chain, disruptive, parsed: actions };
}

/** Every problem Coraza would have with this text; which directives may appear is not its call. */
export function lintSeclang(raw: string, options: SeclangLintOptions = {}): SeclangIssue[] {
  const issues: SeclangIssue[] = [];
  const ids = new Map<number, number>();
  const defaultPhases = new Set<string>();
  /**
   * Coraza parses SecDefaultAction into each later rule, so its errors fail the next rule, or
   * nothing without one. Held until a rule shows up.
   */
  let deferred: SeclangIssue[] = [];
  /** Line of the rule whose `chain` the next rule would join, or null. */
  let chainOpenAt: number | null = null;

  for (const { text, start } of seclangDirectives(raw.replace(/\r\n?/g, "\n"))) {
    if (!text) continue;
    const line = start + 1;
    const report: RuleContext["report"] = (severity, code, params = {}) =>
      issues.push({ line, severity, code, params });
    const ctx: RuleContext = { report };

    // evaluateLine cuts on the first space and strips quotes wrapping the whole remainder.
    const space = text.indexOf(" ");
    const directive = (space === -1 ? text : text.slice(0, space)).toLowerCase();
    let opts = space === -1 ? "" : text.slice(space + 1);
    if (opts.length >= 3 && opts[0] === '"' && opts.endsWith('"'))
      opts = opts.replace(/^"+|"+$/g, "");

    if (directive === "secmarker") {
      if (!opts) report("error", "seclangEmptyDirective", { name: "SecMarker" });
      continue;
    }

    if (directive === "secdefaultaction") {
      if (!opts) {
        report("error", "seclangEmptyDirective", { name: "SecDefaultAction" });
        continue;
      }
      const defer: RuleContext["report"] = (_severity, code, params = {}) =>
        deferred.push({ line, severity: "error", code, params });
      const checked = checkActions(stripQuotes(opts), { report: defer });
      const phase = checked.parsed.find((a) => a.key === "phase")?.value;
      if (checked.parsed.some((a) => a.key === "t"))
        defer("error", "seclangDefaultActionTransformation");
      if (checked.parsed.some((a) => a.key !== "phase" && ACTIONS[a.key]?.kind === "metadata")) {
        defer("error", "seclangDefaultActionMetadata");
      }
      if (!phase) defer("error", "seclangDefaultActionNeedsPhase");
      else {
        const normalized =
          { request: "2", response: "4", logging: "5" }[phase] ?? String(Number(phase));
        if (defaultPhases.has(normalized)) {
          defer("error", "seclangDefaultActionDuplicatePhase", { phase: normalized });
        } else if (options.crsLoaded && (normalized === "1" || normalized === "2")) {
          // crs-setup.conf.example defines both; whether a rule follows depends on where the text
          // lands relative to the CRS, which only the dry run sees.
          report("warning", "seclangDefaultActionDuplicatePhase", { phase: normalized });
        }
        defaultPhases.add(normalized);
      }
      if (!checked.disruptive) defer("error", "seclangDefaultActionNeedsDisruptive");
      continue;
    }

    if (directive !== "secrule" && directive !== "secaction") continue;
    issues.push(...deferred);
    deferred = [];
    if (!opts.trim()) {
      report("error", "seclangEmptyDirective", {
        name: directive === "secrule" ? "SecRule" : "SecAction",
      });
      continue;
    }

    let actionsRaw: string;
    if (directive === "secrule") {
      const rule = splitRule(opts);
      if (!rule) {
        report("error", "seclangRuleFormat");
        continue;
      }
      for (const variable of parseVariables(rule.vars)) {
        const upper = variable.name.toUpperCase();
        if (!VARIABLES.has(upper))
          report("error", "seclangUnknownVariable", { name: variable.name });
        else if (variable.selected && !SELECTABLE_VARIABLES.has(upper)) {
          report("error", "seclangNotSelectable", { name: variable.name });
        }
      }
      // ParseOperator: no leading @ means @rx over the whole string.
      let operator = rule.operator.replace(/\\"/g, '"');
      if (operator === "!") operator = "!@rx";
      else if (operator[0] !== "@" && operator[0] !== "!") operator = `@rx ${operator}`;
      else if (operator[0] === "!" && operator[1] !== "@") operator = `!@rx ${operator.slice(1)}`;
      const opSpace = operator.indexOf(" ");
      const opName = (opSpace === -1 ? operator : operator.slice(0, opSpace))
        .trim()
        .replace(/^!?@/, "");
      const opArgs = opSpace === -1 ? "" : operator.slice(opSpace + 1).trim();
      if (!OPERATORS.has(opName)) report("error", "seclangUnknownOperator", { name: opName });
      else if (opName === "rx") {
        const construct = findUnsupportedRegex(opArgs);
        if (construct) report("error", "seclangUnsupportedRegex", { construct });
      }
      actionsRaw = rule.actions;
    } else {
      actionsRaw = stripQuotes(opts);
      // Unlike SecRule's, SecAction's list is parsed even when empty, and "" is no action.
      if (!actionsRaw) {
        report("error", "seclangEmptyDirective", { name: "SecAction" });
        continue;
      }
    }

    const checked = checkActions(actionsRaw, ctx);
    const isChainMember = chainOpenAt !== null;
    if (isChainMember && checked.disruptive) report("error", "seclangChainDisruptive");
    if (!isChainMember) {
      if (checked.id === null) {
        if (!checked.parsed.some((a) => a.key === "id")) report("warning", "seclangMissingId");
      } else {
        const seen = ids.get(checked.id);
        if (seen !== undefined) {
          report("error", "seclangDuplicateId", { id: String(checked.id), first: String(seen) });
        } else {
          ids.set(checked.id, line);
          if (
            options.crsLoaded &&
            checked.id >= CRS_ID_RANGE.start &&
            checked.id <= CRS_ID_RANGE.end
          ) {
            report("warning", "seclangCrsIdRange", { id: String(checked.id) });
          }
        }
      }
    }
    // A chain member's own `chain` extends the chain; anything else closes it.
    chainOpenAt = checked.chain ? line : null;
  }

  // No rule followed here, but one may follow wherever this text is emitted.
  for (const issue of deferred) issues.push({ ...issue, severity: "warning" });
  if (chainOpenAt !== null) {
    issues.push({
      line: chainOpenAt,
      severity: "warning",
      code: "seclangDanglingChain",
      params: {},
    });
  }
  return issues.sort((a, b) => a.line - b.line);
}

export function seclangErrors(raw: string, options?: SeclangLintOptions): SeclangIssue[] {
  return lintSeclang(raw, options).filter((issue) => issue.severity === "error");
}
