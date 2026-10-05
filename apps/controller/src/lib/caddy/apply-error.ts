import { randomUUID } from "node:crypto";

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

  constructor(
    message: string,
    code: CaddyApplyErrorCode,
    waf: WafRejection = { wafFailed: false, ruleIds: [] },
  ) {
    super(message);
    this.name = "CaddyApplyError";
    this.code = code;
    this.waf = waf;
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
const KNOWN_CADDY_REJECTIONS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /request body limit should be at most 1GiB/i,
    reason: "a WAF request body limit exceeds Coraza's maximum of 1 GiB",
  },
  {
    pattern: /request body limit should be at least the memory limit/i,
    reason: "a WAF in-memory body limit is larger than its request body limit",
  },
  {
    pattern: /body limit should be bigger than 0/i,
    reason: "a WAF body limit is zero",
  },
];

export function describeCaddyRejection(responseBody: string): string | null {
  return KNOWN_CADDY_REJECTIONS.find(({ pattern }) => pattern.test(responseBody))?.reason ?? null;
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
