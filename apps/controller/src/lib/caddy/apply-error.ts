import { randomUUID } from "node:crypto";
import { type DomainError, type DomainErrorCode, domainError } from "../errors/domain-error";

export type CaddyApplyErrorCode = "CADDY_REJECTED" | "CADDY_UNREACHABLE" | "CADDY_REQUEST_FAILED";

/** Read out of Caddy's body without repeating any of it. */
export type WafRejection = {
  /** Coraza could not build a WAF handler: a directive it will not compile. */
  wafFailed: boolean;
  /** Point at whatever defined them. */
  ruleIds: number[];
};

export class CaddyApplyError extends Error {
  readonly code: CaddyApplyErrorCode;
  readonly waf: WafRejection;
  /** The agent whose Caddy refused, when known: a fleet apply still fails on one host. */
  readonly agent: { agentId: string; name: string } | null;
  /** What a reader is shown; `code` above is what callers branch on. */
  readonly localized: DomainError | null;

  constructor(
    message: string | DomainError,
    code: CaddyApplyErrorCode,
    waf: WafRejection = { wafFailed: false, ruleIds: [] },
    agent: { agentId: string; name: string } | null = null,
  ) {
    super(typeof message === "string" ? message : message.message);
    this.name = "CaddyApplyError";
    this.localized = typeof message === "string" ? null : message;
    this.code = code;
    this.waf = waf;
    this.agent = agent;
  }
}

/** Coraza's own wording, from the handler it failed to provision. */
const WAF_BUILD_FAILURE = /provision http\.handlers\.waf|invalid WAF config/i;

export function describeWafRejection(responseBody: string): WafRejection {
  if (!WAF_BUILD_FAILURE.test(responseBody)) return { wafFailed: false, ruleIds: [] };
  // The body escapes the directive it quotes, so an id can arrive as `\"id:123`.
  const ruleIds = [...responseBody.matchAll(/(?:^|[^A-Za-z])id\s*:\s*'?(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  return { wafFailed: true, ruleIds: [...new Set(ruleIds)] };
}

export function safeSystemErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,64}$/.test(code) ? code : null;
}

/**
 * The /load error body quotes the config, so it is never surfaced verbatim; these give an
 * app-authored reason instead. A Coraza error rejects the whole document, so every host stops.
 */
const KNOWN_CADDY_REJECTIONS = [
  {
    pattern: /request body limit should be at most 1GiB/i,
    reason: "a WAF request body limit exceeds Coraza's maximum of 1 GiB",
    codes: ["caddyRejectedWafBodyLimitAboveMax", "caddyRejectedOnWafBodyLimitAboveMax"],
  },
  {
    pattern: /request body limit should be at least the memory limit/i,
    reason: "a WAF in-memory body limit is larger than its request body limit",
    codes: ["caddyRejectedWafMemoryAboveBodyLimit", "caddyRejectedOnWafMemoryAboveBodyLimit"],
  },
  {
    pattern: /body limit should be bigger than 0/i,
    reason: "a WAF body limit is zero",
    codes: ["caddyRejectedWafBodyLimitZero", "caddyRejectedOnWafBodyLimitZero"],
  },
] as const satisfies ReadonlyArray<{
  pattern: RegExp;
  reason: string;
  codes: readonly [DomainErrorCode, DomainErrorCode];
}>;

export function describeCaddyRejection(responseBody: string): string | null {
  return KNOWN_CADDY_REJECTIONS.find(({ pattern }) => pattern.test(responseBody))?.reason ?? null;
}

/** One code per reason and per "on an agent or not", since a reader's language words both. */
export function caddyRejection(responseBody: string, who: string): DomainError {
  const known = KNOWN_CADDY_REJECTIONS.find(({ pattern }) => pattern.test(responseBody));
  if (known) return who ? domainError(known.codes[1], { agent: who }) : domainError(known.codes[0]);
  return who ? domainError("caddyRejectedOn", { agent: who }) : domainError("caddyRejected");
}

/** Log diagnostic metadata without exception messages, response bodies, URLs, or stacks. */
export function logCaddyApplyFailure(
  context: string,
  error?: unknown,
  metadata: Record<string, number | boolean | null> = {},
): string {
  const errorId = randomUUID();
  const code = safeSystemErrorCode(error);
  const rawType = error instanceof Error ? error.name : typeof error;
  const errorType = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawType)
    ? rawType
    : error instanceof Error
      ? "Error"
      : "unknown";
  console.error("Caddy apply failure", {
    errorId,
    context,
    errorType,
    ...(code ? { code } : {}),
    ...metadata,
  });
  return errorId;
}
