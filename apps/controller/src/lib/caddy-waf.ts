/** WAF handler builder and effective-config resolver, split from caddy.ts for unit testing. */
import type { WafSettings } from "./settings";
import type { WafHostConfig } from "./models/proxy-hosts";
import { type DomainErrorCode, domainError, domainErrorMessage } from "./domain-error";
import { type SeclangIssue, seclangDirectives, seclangErrors } from "./seclang";

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
  | "wafDirectiveDroppedBodyLimit"
  | "wafDirectiveDroppedNotAllowed"
  | "wafDirectiveDroppedUnterminated";

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
 * Splits custom directives into kept and dropped lines. The allowlist is the security boundary; a
 * silently dropped line reads as "the WAF ignores my rule", so validators name each one (#146).
 */
export function filterCustomDirectives(raw: string | null | undefined): {
  kept: string[];
  dropped: DroppedWafDirective[];
} {
  const kept: string[] = [];
  const dropped: DroppedWafDirective[] = [];
  if (!raw?.trim()) return { kept, dropped };

  for (const { text, lines } of seclangDirectives(raw.trim())) {
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
    // Out-of-range limits would make Caddy reject the whole config; validation reports them, this
    // is the net. SecRequestBodyNoFilesLimit parses but is not enforced (corazawaf/coraza#896).
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

/** "line -> why" for the validators' error; echoing only lines CPM drops repeats nothing new. */
export function droppedWafDirectiveDetails(dropped: readonly DroppedWafDirective[]): string[] {
  // As strings, or the catalog formats 1073741824 with separators; other reasons ignore them.
  const bounds = { min: String(CORAZA_MIN_BODY_LIMIT), max: String(CORAZA_MAX_BODY_LIMIT) };
  return dropped.map((entry) => `"${entry.line}" - ${domainErrorMessage(entry.reason, bounds)}`);
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
    const { kept } = filterCustomDirectives(presets.get(id));
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
