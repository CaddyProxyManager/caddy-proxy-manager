import {
  DomainError,
  type DomainErrorCode,
  type DomainErrorParams,
  domainError,
  domainErrorMessage,
} from "./domain-error";

export type DefaultResponseMode = "caddy" | "respond" | "redirect" | "abort";

export type DefaultResponseSettings = {
  mode: DefaultResponseMode;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  redirectUrl?: string;
};

export type CaddyDefaultResponseRoute = {
  handle: Array<Record<string, unknown>>;
  terminal: true;
};

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A `DomainError` so the screen translates it; `/api/v1` still answers 400 in English. */
export class DefaultResponseValidationError extends DomainError {
  constructor(code: DomainErrorCode, params: DomainErrorParams = {}) {
    super(code, params, domainErrorMessage(code, params));
    this.name = "DefaultResponseValidationError";
  }
}

function invalid(code: DomainErrorCode, params: DomainErrorParams = {}): never {
  throw new DefaultResponseValidationError(code, params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasForbiddenControlCharacter(value: string, allowTab: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 127 || (code < 32 && (!allowTab || code !== 9))) return true;
  }
  return false;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    invalid("defaultResponseHeadersNotObject");
  }

  const headers: Record<string, string> = {};
  const seenNames = new Set<string>();
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim();
    if (!HEADER_NAME_PATTERN.test(name)) {
      invalid("defaultResponseHeaderNameInvalid", { name: rawName });
    }
    const foldedName = name.toLowerCase();
    if (seenNames.has(foldedName)) {
      invalid("defaultResponseHeaderNameDuplicate", { name });
    }
    if (typeof rawValue !== "string" || hasForbiddenControlCharacter(rawValue, true)) {
      invalid("defaultResponseHeaderValueInvalid", { name });
    }
    seenNames.add(foldedName);
    headers[name] = rawValue.trim();
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Strict: a bad stored value would make Caddy reject every later reload. */
export function normalizeDefaultResponseSettings(value: unknown): DefaultResponseSettings {
  if (!isRecord(value)) {
    invalid("defaultResponseSettingsNotObject");
  }

  const mode = value.mode;
  if (mode !== "caddy" && mode !== "respond" && mode !== "redirect" && mode !== "abort") {
    invalid("defaultResponseModeInvalid");
  }

  if (mode === "caddy" || mode === "abort") {
    return { mode };
  }

  const headers = normalizeHeaders(value.headers);

  if (mode === "redirect") {
    const status = value.status === undefined ? 302 : value.status;
    if (typeof status !== "number" || !Number.isInteger(status) || !REDIRECT_STATUSES.has(status)) {
      invalid("defaultRedirectStatusInvalid");
    }
    if (
      typeof value.redirectUrl !== "string" ||
      value.redirectUrl.trim().length === 0 ||
      hasForbiddenControlCharacter(value.redirectUrl, false)
    ) {
      invalid("defaultRedirectUrlInvalid");
    }
    return {
      mode,
      status,
      redirectUrl: value.redirectUrl.trim(),
      ...(headers ? { headers } : {}),
    };
  }

  const status = value.status === undefined ? 404 : value.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
    invalid("defaultResponseStatusInvalid");
  }
  if (value.body !== undefined && typeof value.body !== "string") {
    invalid("defaultResponseBodyNotString");
  }

  return {
    mode,
    status,
    body: value.body ?? "",
    ...(headers ? { headers } : {}),
  };
}

/** Shape only; `normalizeDefaultResponseSettings` validates the names and values. */
export function parseDefaultResponseHeaders(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;

  const headers: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      // A code, because this reaches the settings screen; see `domain-error.ts`.
      throw domainError("defaultResponseHeaderLineInvalid", { line: rawLine });
    }
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function caddyHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string[]> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]]));
}

export function buildDefaultResponseRoute(
  settings: DefaultResponseSettings | null | undefined,
): CaddyDefaultResponseRoute | null {
  if (!settings || settings.mode === "caddy") return null;

  if (settings.mode === "abort") {
    return {
      handle: [{ handler: "static_response", abort: true }],
      terminal: true,
    };
  }

  const headers = caddyHeaders(settings.headers) ?? {};
  if (settings.mode === "redirect") {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "location") delete headers[name];
    }
    headers.Location = [settings.redirectUrl ?? ""];
  }

  const handler: Record<string, unknown> = {
    handler: "static_response",
    status_code: settings.status,
    ...(settings.mode === "respond" && settings.body ? { body: settings.body } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };

  return { handle: [handler], terminal: true };
}
