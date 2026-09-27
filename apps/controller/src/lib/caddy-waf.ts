/** WAF handler builder and effective-config resolver, split from caddy.ts for unit testing. */
import type { WafSettings } from "./settings";
import type { WafHostConfig } from "./models/proxy-hosts";
import { type DomainErrorCode, domainError, domainErrorMessage } from "./domain-error";
import { type SeclangIssue, seclangDirectives, seclangErrors } from "./seclang";

// ---------------------------------------------------------------------------
// Request body limits
// ---------------------------------------------------------------------------

/**
 * Coraza refuses to build a WAF whose request body limit exceeds 1 GiB
 * (internal/corazawaf/waf.go - "request body limit should be at most 1GiB").
 * coraza-caddy constructs its WAF while Caddy is loading the config, so a
 * single out-of-range value makes Caddy reject the ENTIRE config document -
 * every host goes unapplied, not just the offending one. Never emit a value
 * above this.
 */
export const CORAZA_MAX_BODY_LIMIT = 1_073_741_824; // 1 GiB

/** Below ~1 KiB the limit is meaningless and only serves to break uploads. */
export const CORAZA_MIN_BODY_LIMIT = 1_024;

/** Coraza's built-in default when no SecRequestBodyLimit directive is parsed. */
export const CORAZA_DEFAULT_BODY_LIMIT = 134_217_728; // 128 MiB

/**
 * SecRequestBodyLimit / SecRequestBodyInMemoryLimit set by
 * `@coraza.conf-recommended`, which we Include when load_owasp_crs is on.
 * The 12.5 MiB limit is why large uploads (Nextcloud/Immich chunks) fail with
 * the CRS enabled while the same host works with it off.
 */
export const CRS_BODY_LIMIT = 13_107_200; // 12.5 MiB
export const CRS_IN_MEMORY_BODY_LIMIT = 131_072; // 128 KiB

/** True when `value` is a byte count Coraza will accept for a body limit. */
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

/**
 * The settings are stored in bytes (what SecLang takes), but the forms ask for
 * MiB - nobody sizes an upload limit in bytes. Anything finer stays reachable
 * through the custom directives.
 */
export const BYTES_PER_MIB = 1_048_576;
export const MIN_BODY_LIMIT_MIB = 1;
export const MAX_BODY_LIMIT_MIB = CORAZA_MAX_BODY_LIMIT / BYTES_PER_MIB; // 1024

export function bytesToMib(bytes: number | undefined): string {
  return typeof bytes === "number" && bytes > 0 ? String(Math.round(bytes / BYTES_PER_MIB)) : "";
}

/**
 * Which field a body limit came from. Each is its own message rather than a label spliced into one,
 * because not every language puts the field name first.
 */
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

/** SecRequestBody*Limit directives that carry a byte count. */
const BODY_LIMIT_DIRECTIVE =
  /^(SecRequestBodyLimit|SecRequestBodyNoFilesLimit|SecRequestBodyInMemoryLimit)\s+(\d+)\s*$/i;
const BODY_LIMIT_ACTION_DIRECTIVE = /^SecRequestBodyLimitAction\s+(?:Reject|ProcessPartial)\s*$/i;

/**
 * Returns the first custom directive whose byte count Coraza would reject, or
 * null when every body-limit line is in range. Input layers call this so the
 * user gets a precise error at save time instead of a silent drop here plus an
 * opaque "Caddy rejected configuration" later.
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

/**
 * Why a custom SecLang line never reaches Caddy. A code rather than a sentence: the wording lives
 * in the catalog, next to every other sentence a person reads.
 */
export type DroppedWafDirectiveReason =
  | "wafDirectiveDroppedInclude"
  | "wafDirectiveDroppedRuleMutation"
  | "wafDirectiveDroppedCtlRuleEngine"
  | "wafDirectiveDroppedBodyLimit"
  | "wafDirectiveDroppedNotAllowed"
  | "wafDirectiveDroppedUnterminated";

/** A custom SecLang line CPM will not send to Caddy, and why. */
export type DroppedWafDirective = { line: string; reason: DroppedWafDirectiveReason };

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

/**
 * Splits the user's custom directives into the lines that will be emitted and the ones this drops.
 *
 * The allowlist is the security boundary and stays exactly as strict as it was; what changed is
 * that a dropped line is now something to say out loud. A silently discarded
 * `SecRuleUpdateActionById` reads as "the WAF ignores my rule" rather than "CPM refused that
 * directive", so both validators fail the write and name each line (upstream discussion #146).
 */
export function filterCustomDirectives(raw: string | null | undefined): {
  kept: string[];
  dropped: DroppedWafDirective[];
} {
  const kept: string[] = [];
  const dropped: DroppedWafDirective[] = [];
  if (!raw?.trim()) return { kept, dropped };

  for (const { text, lines } of seclangDirectives(raw.trim())) {
    // Blank lines and comments carry nothing to reject.
    if (text === "") {
      kept.push(...lines);
      continue;
    }
    // A dangling `\` would join whatever CPM emits next - a preset, or SecRuleEngine - onto it.
    if (text === null) {
      dropped.push({ line: lines.join("\n").trim(), reason: "wafDirectiveDroppedUnterminated" });
      continue;
    }
    // Include would read arbitrary files out of the container filesystem.
    if (/^Include\s/i.test(text)) {
      dropped.push({ line: text, reason: "wafDirectiveDroppedInclude" });
      continue;
    }
    // Body limits are allowed, but only inside the range Coraza accepts - an out-of-range value
    // would make Caddy reject the whole config document. Input validation reports these; dropping
    // here is the net. (SecRequestBodyNoFilesLimit parses but is not enforced by Coraza:
    // corazawaf/coraza#896. Kept accepted so existing configs keep loading.)
    const bodyLimit = BODY_LIMIT_DIRECTIVE.exec(text);
    if (bodyLimit) {
      if (isValidBodyLimit(Number(bodyLimit[2]))) kept.push(...lines);
      else dropped.push({ line: text, reason: "wafDirectiveDroppedBodyLimit" });
      continue;
    }
    if (BODY_LIMIT_ACTION_DIRECTIVE.test(text)) {
      kept.push(...lines);
      continue;
    }
    // Before the generic allowlist, so the reason names the real objection.
    if (BLOCKED_SEC_RULE_PREFIXES.some((pattern) => pattern.test(text))) {
      dropped.push({ line: text, reason: "wafDirectiveDroppedRuleMutation" });
      continue;
    }
    if (!ALLOWED_DIRECTIVE_PREFIXES.some((pattern) => pattern.test(text))) {
      dropped.push({ line: text, reason: "wafDirectiveDroppedNotAllowed" });
      continue;
    }
    // ctl:ruleEngine inside an allowed rule can conditionally disable the WAF. Coraza trims around
    // the colon, so this does too.
    if (/ctl\s*:\s*ruleEngine/i.test(text)) {
      dropped.push({ line: text, reason: "wafDirectiveDroppedCtlRuleEngine" });
      continue;
    }
    kept.push(...lines);
  }
  return { kept, dropped };
}

/**
 * The "line -> why" list both validators put in their error. Echoing the line back is safe: only
 * lines CPM is about to drop are named, so nothing new is repeated to the caller.
 */
export function droppedWafDirectiveDetails(dropped: readonly DroppedWafDirective[]): string[] {
  // The bounds go as strings, or the catalog would format 1073741824 with separators. Only the
  // body-limit reason reads them; the others ignore the extra params.
  const bounds = { min: String(CORAZA_MIN_BODY_LIMIT), max: String(CORAZA_MAX_BODY_LIMIT) };
  return dropped.map((entry) => `"${entry.line}" - ${domainErrorMessage(entry.reason, bounds)}`);
}

/**
 * The "line N: why" list the validators put in their error for what the linter found. At most
 * `limit`, since one typo early in a rule list can make every later line look wrong.
 */
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

/** An installed CRS plugin's three files, as the builder emits them. */
export type CrsPluginRules = { config: string; before: string; after: string };

/**
 * Why a CRS plugin file cannot be loaded. A code for the same reason the custom-directive ones are:
 * the sentence lives in the catalog.
 */
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
 * What a plugin may contain. Wider than the custom-directive allowlist, because rewriting CRS
 * rules' targets from an -after file is what an exclusion plugin is for; every registered plugin
 * uses only SecRule, SecAction, SecMarker and SecRuleUpdateTargetById.
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

/**
 * ModSecurity's persistent collections - read as a variable, written by setvar, or opened by
 * initcol. Coraza refuses to compile the rule, as dos-protection-modsecurity shows.
 */
const PERSISTENT_COLLECTION =
  /^SecRule\s+(?:\S*\|)?[!&]*(?:IP|SESSION|USER|GLOBAL|RESOURCE)(?::|\s)|setvar\s*:\s*'?(?:ip|session|user|global|resource)\.|\binitcol\s*:/i;

/** Double quotes outside a backslash escape. An odd count is google-oauth2's unclosed action list. */
function hasUnbalancedQuotes(text: string): boolean {
  return (text.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1;
}

/** `id:123`, not `ctl:ruleRemoveById=123`: a rule's own id, the one the registry range bounds. */
const RULE_ID = /(?:^|[\s"',])id\s*:\s*'?(\d+)/g;

/**
 * Checks one plugin file before it is stored and again before it is emitted. Coraza compiles every
 * host's rules as Caddy loads the config, so a plugin it cannot compile takes the whole config down
 * - which is also why the registry's range is enforced: a duplicate rule id is such a failure.
 */
export function findCrsPluginRejections(
  raw: string,
  range: { start: number; end: number },
): CrsPluginRejection[] {
  const rejections: CrsPluginRejection[] = [];
  const normalized = raw.replace(/\r\n?/g, "\n");
  /** Where the checks below refused a directive, so the linter does not name it a second time. */
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

  // Override mode: use host config entirely
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

  // Merge mode: start with global, overlay host fields.
  // host.enabled === false is an explicit opt-out - respect it even when global is on.
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
      // Body limits are scalars, not lists: the host value wins when set,
      // otherwise the global one applies.
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
): Record<string, unknown> {
  const parts: string[] = [];

  // `mode` is interpolated straight into the directive block and settings are stored unvalidated,
  // so anything but a known engine mode would smuggle in SecLang past the allowlist. Clamp to
  // Coraza's three real values.
  const engineMode = waf.mode === "Off" || waf.mode === "DetectionOnly" ? waf.mode : "On";

  if (waf.load_owasp_crs) {
    // @-prefixed paths resolve from the embedded coraza-coreruleset filesystem,
    // which is only mounted when load_owasp_crs is true.
    parts.push("Include @coraza.conf-recommended", "Include @crs-setup.conf.example");
  }

  // CRS 4's plugin order: every -config, then every -before, the rules, then every -after. Plugins
  // tune and exclude CRS rules, so without the CRS they are left out. An unknown id is a plugin
  // uninstalled under a stale selection, and emits nothing.
  const selectedPlugins = waf.load_owasp_crs
    ? [...new Set(waf.plugin_ids ?? [])].flatMap((id) => plugins.get(id) ?? [])
    : [];
  const pluginPart = (file: keyof CrsPluginRules) => {
    for (const plugin of selectedPlugins) if (plugin[file].trim()) parts.push(plugin[file].trim());
  };
  pluginPart("config");
  pluginPart("before");

  // Presets sit with the plugins' -before files: after crs-setup, ahead of the rules. A runtime
  // exclusion (ctl:ruleRemove*) only works on rules that have not run yet. An unknown id is a
  // preset deleted under a stale selection, and emits nothing.
  for (const id of new Set(waf.preset_ids ?? [])) {
    const { kept } = filterCustomDirectives(presets.get(id));
    if (kept.length > 0) parts.push(kept.join("\n"));
  }

  if (waf.load_owasp_crs) parts.push("Include @owasp_crs/*.conf");
  pluginPart("after");

  // Runtime-validate excluded_rule_ids are positive integers
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
    // RelevantOnly logs transactions where a rule fired with the auditlog action (which all
    // OWASP CRS rules set via SecDefaultAction), covering blocked and DetectionOnly hits. Clean
    // requests with no matches are skipped, avoiding massive log growth.
    "SecAuditEngine RelevantOnly",
    "SecAuditLog /logs/waf-audit.log",
    "SecAuditLogFormat JSON",
    // The caddy image ships the audit log pre-created as caddy-owned 0660, which a new volume copies
    // in, and Coraza opens an existing file without touching its mode - so the agent can truncate
    // it through caddy's group. No SecAuditLogFileMode: the container's 0022 umask would strip the
    // group-write bit from it anyway. A file Coraza creates itself is 0644, and the agent reports
    // that on the Agents page. Part H carries the matched rules; bodies (I, J, E) and headers (D)
    // are omitted to avoid huge writes.
    "SecAuditLogParts ABFHZ",
    "SecResponseBodyAccess Off",
  );

  // Body limits from the dedicated settings fields. Emitted after the CRS
  // include (so they override @coraza.conf-recommended's 12.5 MiB) but before
  // custom_directives, which stay the escape hatch that wins over the UI.
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

  // Allowlist approach: only known-safe directive prefixes reach the handler. The validators
  // refuse a write that would drop a line, so by here `dropped` is normally empty - this stays the
  // net for rows written before that check existed.
  const { kept } = filterCustomDirectives(waf.custom_directives);
  if (kept.length > 0) {
    parts.push(kept.join("\n"));
  }

  const handler: Record<string, unknown> = {
    handler: "waf",
    directives: reconcileInMemoryBodyLimit(parts.join("\n"), waf.load_owasp_crs),
  };
  if (waf.load_owasp_crs) handler.load_owasp_crs = true;
  return handler;
}

/**
 * Coraza also validates `SecRequestBodyInMemoryLimit <= SecRequestBodyLimit`
 * and fails config load when it doesn't hold. That pairing is easy to break by
 * accident: lowering only the request limit leaves the CRS's 128 KiB in-memory
 * value above it, and the resulting rejection takes down every host's config,
 * not just this handler's.
 *
 * Coraza validates the FINAL parsed values, so only the last directive of each
 * kind matters. When they conflict, append a corrective in-memory line - the
 * last one wins, so the config stays loadable with the user's request limit
 * intact.
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
