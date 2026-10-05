/**
 * Model errors a person reads. Models run for actions, `/api/v1/*` and the agent's sync, and only
 * actions have a reader's language: so a code plus an English sentence, which REST keeps returning.
 */

import en from "../../../messages/en.json";

export type DomainErrorCode = keyof typeof en.errors;

/** Joined with ", " in English; `extractErrorMessage` list-formats it for a reader. */
export type DomainErrorParams = Record<string, string | number | readonly string[]>;

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    readonly params: DomainErrorParams,
    message: string,
    /** The 4xx `/api/v1` answers with; without one REST treats it as any error. */
    readonly status?: number,
  ) {
    // The same guard as ApiClientError: a status is a promise the message is safe to hand back.
    if (status !== undefined && (!Number.isInteger(status) || status < 400 || status > 499)) {
      throw new RangeError("DomainError status must be a 4xx status code");
    }
    super(message);
    this.name = "DomainError";
  }
}

export function domainErrorMessage(code: DomainErrorCode, params: DomainErrorParams = {}): string {
  return en.errors[code].replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in params)) return whole;
    const value = params[name];
    return typeof value === "object" ? value.join(", ") : String(value);
  });
}

/** English from the catalog, so API clients and browsers can never drift apart. */
export function domainError(
  code: DomainErrorCode,
  params: DomainErrorParams = {},
  options: { status?: number } = {},
): DomainError {
  return new DomainError(code, params, domainErrorMessage(code, params), options.status);
}

/** Stored by background jobs beside the English, to render later; see `storedErrorMessage`. */
export type StoredErrorCode = { code: DomainErrorCode; params: DomainErrorParams };

export function storedErrorCode(error: unknown): StoredErrorCode | null {
  return error instanceof DomainError ? { code: error.code, params: error.params } : null;
}
