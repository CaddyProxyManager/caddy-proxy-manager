/**
 * "Why was this blocked": the rules a stored audit record matched, the points each added and the
 * score they reached. Client safe; it reads only the redacted record.
 */

import { SEVERITY_POINTS } from "./tuning";

export type WafMatchedRule = {
  ruleId: number | null;
  message: string;
  severity: string | null;
  /** What the rule added to the anomaly score; 0 for a severity the CRS does not score. */
  points: number;
  /** The variable that matched, e.g. `ARGS:id`. */
  variable: string | null;
  /** The part of it the rule matched, as the record kept it. */
  data: string | null;
  paranoiaLevel: number | null;
  tags: string[];
};

export type WafEventExplanation = {
  rules: WafMatchedRule[];
  /** The score the evaluation rule reported, else the sum of the rules' points. */
  totalScore: number;
  scoreReported: boolean;
  threshold: number;
  /** The rule that ended the request: the anomaly evaluation, or a rule that denies by itself. */
  decidingRuleId: number | null;
};

/** The CRS's score evaluation and reporting rules: they sum the others rather than match. */
export const ANOMALY_EVALUATION_RULE_IDS: readonly number[] = [
  949110, 949111, 959100, 959101, 980130, 980170,
];

type AuditMessage = {
  message?: string;
  error_message?: string;
  details?: {
    ruleId?: number | string;
    msg?: string;
    severity?: string;
    match?: string;
    data?: string;
    logdata?: string;
    tags?: string[];
  };
};

type AuditRecord = {
  messages?: AuditMessage[];
  transaction?: {
    request?: {
      method?: string;
      uri?: string;
      protocol?: string;
      headers?: Record<string, string | string[]>;
      body?: string;
    };
  };
};

function field(text: string, name: string): string | null {
  const match = new RegExp(`\\[${name} "((?:[^"\\\\]|\\\\.)*)"\\]`).exec(text);
  return match ? match[1] : null;
}

function fields(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`\\[${name} "((?:[^"\\\\]|\\\\.)*)"\\]`, "g"))].map(
    (match) => match[1],
  );
}

/** `Matched Data: X found within ARGS:id: value` names the variable and the excerpt. */
export function splitMatchedData(data: string | null): {
  variable: string | null;
  data: string | null;
} {
  if (!data) return { variable: null, data: null };
  const found = /^Matched Data: (.*) found within ([A-Z_]+(?::[^:\s]+)?):/s.exec(data);
  if (found) return { variable: found[2], data: found[1] };
  const header = /^Matched Data: Header (\S+): (.*)$/s.exec(data);
  if (header) return { variable: `REQUEST_HEADERS:${header[1]}`, data: header[2] };
  return { variable: null, data };
}

function parseRecord(rawData: string | null): AuditRecord | null {
  if (!rawData) return null;
  try {
    const parsed: unknown = JSON.parse(rawData);
    return parsed && typeof parsed === "object" ? (parsed as AuditRecord) : null;
  } catch {
    return null;
  }
}

function ruleOf(message: AuditMessage): WafMatchedRule & { score: number | null } {
  const text = message.error_message || message.message || "";
  const details = message.details;
  const rawId = details?.ruleId ?? field(text, "id");
  const ruleId = rawId === null || rawId === undefined ? null : Number.parseInt(String(rawId), 10);
  const severity = details?.severity ?? field(text, "severity");
  const tags = details?.tags ?? fields(text, "tag");
  const level = tags.map((tag) => /^paranoia-level\/(\d)$/.exec(tag)?.[1]).find(Boolean);
  const { variable, data } = splitMatchedData(
    details?.match ?? details?.logdata ?? details?.data ?? field(text, "data"),
  );
  const msg = details?.msg ?? field(text, "msg") ?? message.message ?? "";
  const score = /Total Score: (\d+)/.exec(`${msg} ${text}`)?.[1];
  return {
    ruleId: Number.isFinite(ruleId) ? ruleId : null,
    message: msg,
    severity: severity ?? null,
    points: severity ? (SEVERITY_POINTS[severity.toUpperCase()] ?? 0) : 0,
    variable,
    data,
    paranoiaLevel: level ? Number(level) : null,
    tags,
    score: score ? Number(score) : null,
  };
}

export function explainWafEvent(
  rawData: string | null,
  options: {
    threshold: number;
    blocked: boolean;
    /** The event's own rule, for a record that lists none (a build without audit part H). */
    rule?: { ruleId: number | null; message: string | null; severity: string | null };
  },
): WafEventExplanation {
  const record = parseRecord(rawData);
  const messages: AuditMessage[] = record?.messages?.length
    ? record.messages
    : options.rule?.ruleId != null
      ? [
          {
            details: {
              ruleId: options.rule.ruleId,
              msg: options.rule.message ?? "",
              severity: options.rule.severity ?? undefined,
            },
          },
        ]
      : [];
  const all = messages.map(ruleOf);
  const evaluations = all.filter(
    (rule) => rule.ruleId !== null && ANOMALY_EVALUATION_RULE_IDS.includes(rule.ruleId),
  );
  const rules = all
    .filter((rule) => !evaluations.includes(rule))
    .map(({ score: _score, ...rule }) => rule);
  const reported = evaluations.find((rule) => rule.score !== null)?.score ?? null;
  const inbound = evaluations.find((rule) => rule.ruleId === 949110 || rule.ruleId === 949111);
  // Without an evaluation, a blocked request was denied by a rule of its own: the last one, as
  // a disruptive rule ends the phase.
  const deciding = inbound?.ruleId ?? (options.blocked ? (rules.at(-1)?.ruleId ?? null) : null);
  return {
    rules,
    totalScore: reported ?? rules.reduce((sum, rule) => sum + rule.points, 0),
    scoreReported: reported !== null,
    threshold: options.threshold,
    decidingRuleId: deciding,
  };
}

/** Single-quoted for a POSIX shell; a quote inside closes, escapes and reopens. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Go accepts any token as a method, quotes and `$` included; anything but a plain verb is dropped.
const SAFE_METHOD = /^[A-Z]{1,16}$/;

const SKIPPED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

/**
 * The request as a curl command, from the stored record. Its credentials are already `[redacted]`
 * and stay so, which leaves a visible placeholder to fill in rather than a silently missing header.
 */
export function wafEventCurl(
  rawData: string | null,
  fallback: { host: string; method: string; uri: string },
): string {
  const request = parseRecord(rawData)?.transaction?.request;
  const claimed = (request?.method || fallback.method || "GET").toUpperCase();
  const method = SAFE_METHOD.test(claimed) ? claimed : "GET";
  const uri = request?.uri || fallback.uri || "/";
  const headers = request?.headers ?? {};
  const hostHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === "host")?.[1];
  const host = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) || fallback.host;
  const parts = ["curl", "-X", shellQuote(method), shellQuote(`https://${host}${uri}`)];
  for (const [name, value] of Object.entries(headers)) {
    if (SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      parts.push("-H", shellQuote(`${name}: ${one}`));
    }
  }
  if (request?.body) parts.push("--data-raw", shellQuote(request.body));
  return parts.join(" ");
}
