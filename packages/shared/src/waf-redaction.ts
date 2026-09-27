/**
 * Credentials scrubbed from a Coraza audit entry before it is stored. The agent redacts what it
 * parses and the controller redacts again on ingest, since an older agent sends entries raw; every
 * step is idempotent so the second pass changes nothing.
 */
import type { WafEventRow } from "./agent-protocol";

// Coraza's audit parts B and F record headers verbatim; Caddy's access log redacts these.
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-cpm-forward-auth-proof",
  "x-plex-token",
  "x-emby-token",
  "x-emby-authorization",
  "x-mediabrowser-token",
  "private-token",
  "x-vault-token",
]);

export const WAF_REDACTED = "[redacted]";

/** A name holding one of these words, split at non-alphanumerics and camelCase, is a credential. */
const CREDENTIAL_NAME_WORDS = new Set([
  "apikey",
  "auth",
  "authorization",
  "code",
  "credential",
  "credentials",
  "jwt",
  "key",
  "pass",
  "passphrase",
  "passwd",
  "password",
  "pwd",
  "secret",
  "session",
  "sessionid",
  "sid",
  "sig",
  "signature",
  "token",
]);

/** Whether a header, query parameter or form field name carries a credential. */
export function isCredentialName(name: string): boolean {
  if (CREDENTIAL_HEADERS.has(name.toLowerCase())) return true;
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => CREDENTIAL_NAME_WORDS.has(word));
}

/** `uri` with every credential-named query parameter's value replaced. */
export function redactQueryString(uri: string): string {
  const query = uri.indexOf("?");
  if (query === -1) return uri;
  const params = uri
    .slice(query + 1)
    .split("&")
    .map((param) => {
      const separator = param.indexOf("=");
      const rawName = separator === -1 ? param : param.slice(0, separator);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, " "));
      } catch {
        // Not valid percent-encoding: judge the raw name.
      }
      return separator !== -1 && isCredentialName(name) ? `${rawName}=${WAF_REDACTED}` : param;
    });
  return `${uri.slice(0, query + 1)}${params.join("&")}`;
}

// CRS logdata such as "Matched Data: %{TX.0} found within %{MATCHED_VAR_NAME}: %{MATCHED_VAR}"
// echoes the variable's value, so these are the names whose value it must not keep.
const COOKIE_VARIABLE_PREFIX = "request_cookies:";
const HEADER_VARIABLE_PREFIXES = ["request_headers:", "response_headers:"];
const ARGS_VARIABLE_PREFIXES = ["args:", "args_get:", "args_post:"];
const CREDENTIAL_HEADER_VARIABLES = [...CREDENTIAL_HEADERS].flatMap((name) =>
  HEADER_VARIABLE_PREFIXES.map((prefix) => `${prefix}${name}`),
);
const URI_VARIABLES = new Set(["request_uri", "request_uri_raw", "request_line", "query_string"]);
/** A quick skip for messages that cannot name any of them. */
const CREDENTIAL_COLLECTION =
  /REQUEST_COOKIES:|(?:REQUEST|RESPONSE)_HEADERS:|ARGS(?:_GET|_POST)?:|REQUEST_URI|REQUEST_LINE|QUERY_STRING/i;
const MATCHED_DATA = "Matched Data: ";
const MATCHED_HEADER = "Matched Data: Header ";
const FOUND_WITHIN = " found within ";
/** Coraza cuts a rule's msg and logdata to this many bytes before logging them. */
const CORAZA_LOG_DATA_CAP = 280;
/** Coraza Go-quotes the value, so an escaped quote never ends it early. */
const RULE_MESSAGE_FIELD = /\[([A-Za-z0-9_]+) "((?:[^"\\]|\\.)*)"\]/g;
/** Chained rules add numbered msg and data fields. */
const MSG_OR_DATA_FIELD = /^(?:msg|data)(?:_match_\d+)?$/;
/** ErrorLog writes the msg unquoted after this prefix. */
const ERROR_LOG_ACTION = /^\s*Coraza: (?:Warning|[A-Za-z ]+ \(phase \d+\))\. /;

function redactHeaderMap(headers: unknown): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return headers;
  // fromEntries defines own properties, so a header named "__proto__" stays a key.
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([name, value]) => [
      name,
      isCredentialName(name)
        ? Array.isArray(value)
          ? value.map(() => WAF_REDACTED)
          : WAF_REDACTED
        : value,
    ]),
  );
}

/** Whether the request or response carried a credential header, a cookie included. */
export function auditEntryCarriesCredentials(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const tx = (entry as { transaction?: unknown }).transaction;
  if (!tx || typeof tx !== "object") return false;
  return (["request", "response"] as const).some((part) => {
    const headers = (tx as Record<string, { headers?: unknown } | undefined>)[part]?.headers;
    if (!headers || typeof headers !== "object") return false;
    return Object.entries(headers).some(
      ([name, value]) =>
        isCredentialName(name) &&
        (Array.isArray(value) ? value.some((v) => Boolean(v)) : Boolean(value)),
    );
  });
}

function isCredentialVariable(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(COOKIE_VARIABLE_PREFIX)) return true;
  const prefix = [...HEADER_VARIABLE_PREFIXES, ...ARGS_VARIABLE_PREFIXES].find((p) =>
    lower.startsWith(p),
  );
  return prefix !== undefined && isCredentialName(name.slice(prefix.length));
}

/** A credential variable name the cap cut short, e.g. `REQUEST_COO`. */
function isCredentialVariablePrefix(text: string): boolean {
  const lower = text.toLowerCase();
  return [COOKIE_VARIABLE_PREFIX, ...CREDENTIAL_HEADER_VARIABLES].some(
    (name) => name.length > lower.length && name.startsWith(lower),
  );
}

/** An ARGS variable whose name may have been cut, so it cannot be judged. */
function isArgsVariablePrefix(text: string): boolean {
  const lower = text.toLowerCase();
  return ARGS_VARIABLE_PREFIXES.some(
    (prefix) => lower.startsWith(prefix) || prefix.startsWith(lower),
  );
}

function redactUriVariable(name: string, value: string): string | null {
  return URI_VARIABLES.has(name.toLowerCase()) ? redactQueryString(value) : null;
}

function utf8Length(codePoint: number): number {
  if (!(codePoint >= 0)) return 1;
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) bytes += utf8Length(char.codePointAt(0) ?? 0);
  return bytes;
}

/** Byte length of the text a Go-quoted (%q) string holds, escapes decoded. */
function goQuotedByteLength(quoted: string): number {
  let bytes = 0;
  for (let i = 0; i < quoted.length; ) {
    if (quoted[i] === "\\" && i + 1 < quoted.length) {
      const kind = quoted[i + 1];
      if (kind === "x") {
        bytes += 1;
        i += 4;
      } else if (kind === "u" || kind === "U") {
        const digits = kind === "u" ? 4 : 8;
        bytes += utf8Length(Number.parseInt(quoted.slice(i + 2, i + 2 + digits), 16));
        i += 2 + digits;
      } else if (kind >= "0" && kind <= "7") {
        bytes += 1;
        i += 4;
      } else {
        bytes += 1;
        i += 2;
      }
      continue;
    }
    const codePoint = quoted.codePointAt(i) ?? 0;
    bytes += utf8Length(codePoint);
    i += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

/**
 * Redacts the credential a rule's msg or logdata reports. The variable name is read only where
 * logdata puts it (after the first " found within ", after "Matched Data: Header ", or leading a
 * NAME=VALUE / NAME: VALUE), since what surrounds it is request data an attacker chose.
 *
 * `capped` text may have lost NAME to Coraza's 280-byte cut: then a credentialed transaction's
 * excerpt is redacted when what is left could start a credential name, and an ARGS name always.
 */
function redactCredentialText(text: string, credentialed: boolean, capped: boolean): string {
  if (!text.startsWith(MATCHED_DATA)) {
    const separator = [text.indexOf("="), text.indexOf(": ")]
      .filter((index) => index > 0)
      .reduce((first, index) => Math.min(first, index), Number.POSITIVE_INFINITY);
    if (separator === Number.POSITIVE_INFINITY) return text;
    const name = text.slice(0, separator);
    const valueStart = separator + (text[separator] === "=" ? 1 : 2);
    const uriValue = redactUriVariable(name, text.slice(valueStart));
    if (uriValue !== null) return `${text.slice(0, valueStart)}${uriValue}`;
    if (!isCredentialVariable(name)) return text;
    return text[separator] === "=" ? `${name}=${WAF_REDACTED}` : `${name}: ${WAF_REDACTED}`;
  }
  const within = text.indexOf(FOUND_WITHIN, MATCHED_DATA.length);
  if (within === -1) {
    if (text.startsWith(MATCHED_HEADER)) {
      const separator = text.indexOf(": ", MATCHED_HEADER.length);
      return separator !== -1 && isCredentialVariable(text.slice(MATCHED_HEADER.length, separator))
        ? `${text.slice(0, separator)}: ${WAF_REDACTED}`
        : text;
    }
    return credentialed && capped ? `${MATCHED_DATA}${WAF_REDACTED}` : text;
  }
  const after = text.slice(within + FOUND_WITHIN.length);
  // A credential never holds " found within ", so a second one came from request data.
  if (after.includes(FOUND_WITHIN)) return text;
  const separator = after.indexOf(": ");
  if (separator !== -1) {
    const uriValue = redactUriVariable(after.slice(0, separator), after.slice(separator + 2));
    if (uriValue !== null) {
      return `${text.slice(0, within + FOUND_WITHIN.length)}${after.slice(0, separator + 2)}${uriValue}`;
    }
  }
  const credential =
    separator === -1
      ? isCredentialVariable(after) ||
        isCredentialVariable(after.replace(/:$/, "")) ||
        (credentialed && isCredentialVariablePrefix(after)) ||
        (capped && isArgsVariablePrefix(after))
      : isCredentialVariable(after.slice(0, separator));
  if (!credential) return text;
  const name = separator === -1 ? after : `${after.slice(0, separator)}: ${WAF_REDACTED}`;
  return `${MATCHED_DATA}${WAF_REDACTED}${FOUND_WITHIN}${name}`;
}

/** A plain (not Go-quoted) msg or logdata, such as an event's stored rule_message. */
export function redactWafRuleText(text: string, credentialed: boolean): string {
  return redactCredentialText(text, credentialed, utf8ByteLength(text) >= CORAZA_LOG_DATA_CAP);
}

/** A ModSecurity-format rule message with its msg and data fields, and the unquoted msg, redacted. */
function redactRuleMessage(message: string, credentialed: boolean): string {
  if (!message.includes(MATCHED_DATA) && !CREDENTIAL_COLLECTION.test(message)) return message;
  const between = (segment: string) => {
    const action = ERROR_LOG_ACTION.exec(segment)?.[0] ?? "";
    const msg = segment.slice(action.length).trimEnd();
    return `${action}${redactWafRuleText(msg, credentialed)}${segment.slice(action.length + msg.length)}`;
  };
  let out = "";
  let last = 0;
  for (const field of message.matchAll(RULE_MESSAGE_FIELD)) {
    const [whole, name, value] = field;
    out += between(message.slice(last, field.index));
    out += MSG_OR_DATA_FIELD.test(name)
      ? `[${name} "${redactCredentialText(value, credentialed, goQuotedByteLength(value) >= CORAZA_LOG_DATA_CAP)}"]`
      : whole;
    last = field.index + whole.length;
  }
  return out + between(message.slice(last));
}

function redactMessages(messages: unknown, credentialed: boolean): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const m = message as Record<string, unknown>;
    // error_message is part H (older Coraza wrote it to `message`); data.* is part K.
    if (typeof m.error_message === "string") {
      m.error_message = redactRuleMessage(m.error_message, credentialed);
    }
    if (typeof m.message === "string") m.message = redactRuleMessage(m.message, credentialed);
    const data = m.data as Record<string, unknown> | null | undefined;
    if (data && typeof data === "object") {
      if (typeof data.msg === "string") data.msg = redactWafRuleText(data.msg, credentialed);
      if (typeof data.data === "string") data.data = redactWafRuleText(data.data, credentialed);
    }
  }
}

/** A redacted copy of an audit entry: credential headers, query parameters and echoed values. */
export function redactAuditEntry<T>(entry: T): T {
  if (!entry || typeof entry !== "object") return entry;
  const credentialed = auditEntryCarriesCredentials(entry);
  // The entry came from JSON, so a JSON round trip is a faithful deep copy.
  const copy = JSON.parse(JSON.stringify(entry)) as {
    transaction?: Record<string, unknown>;
    messages?: unknown;
  };
  const tx = copy.transaction;
  if (tx && typeof tx === "object") {
    const request = tx.request as Record<string, unknown> | undefined;
    if (request && typeof request === "object" && typeof request.uri === "string") {
      request.uri = redactQueryString(request.uri);
    }
    for (const part of ["request", "response"] as const) {
      const section = tx[part] as Record<string, unknown> | undefined;
      if (section && typeof section === "object" && "headers" in section) {
        section.headers = redactHeaderMap(section.headers);
      }
    }
  }
  redactMessages(copy.messages, credentialed);
  return copy as T;
}

/**
 * The redacted entry serialized for raw_data. unix_timestamp is nanoseconds, past a JS number's
 * precision, so the original line's digits are put back.
 */
export function storedAuditRawData(line: string, redacted: unknown): string {
  const json = JSON.stringify(redacted);
  const ts = (redacted as { transaction?: { unix_timestamp?: unknown } } | null)?.transaction
    ?.unix_timestamp;
  if (typeof ts !== "number" || Number.isSafeInteger(ts)) return json;
  const original = /"unix_timestamp"\s*:\s*(\d+)\s*[,}]/.exec(line)?.[1];
  if (!original || Number(original) !== ts) return json;
  return json.replace(`"unix_timestamp":${JSON.stringify(ts)}`, `"unix_timestamp":${original}`);
}

/**
 * A WAF event as the controller stores it, whatever the agent that sent it redacted. raw_data
 * that is not an audit entry cannot be checked, so it is dropped rather than kept.
 */
export function redactWafEventRow(row: WafEventRow): WafEventRow {
  let rawData: string | null = null;
  let credentialed = false;
  if (row.raw_data !== null) {
    try {
      const entry: unknown = JSON.parse(row.raw_data);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        credentialed = auditEntryCarriesCredentials(entry);
        rawData = storedAuditRawData(row.raw_data, redactAuditEntry(entry));
      }
    } catch {
      // Not JSON: dropped below.
    }
  }
  return {
    ...row,
    uri: redactQueryString(row.uri),
    rule_message:
      row.rule_message === null ? null : redactWafRuleText(row.rule_message, credentialed),
    raw_data: rawData,
  };
}
