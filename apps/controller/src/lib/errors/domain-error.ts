/**
 * Model errors a person reads. Models run for actions, `/api/v1/*` and the agent's sync, and only
 * actions have a reader's language: so a code plus an English sentence, which REST keeps returning.
 */

// Named, so a client bundle carries this namespace and not the whole catalog.
import { errors as englishErrors } from "../../../messages/en.json";

export type DomainErrorCode = keyof typeof englishErrors;

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
  return englishErrors[code].replace(/\{(\w+)\}/g, (whole, name: string) => {
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

/** The DomainError an error is, or carries in `localized` beside codes of its own. */
export function domainErrorOf(error: unknown): DomainError | null {
  if (error instanceof DomainError) return error;
  if (error instanceof Error && "localized" in error && error.localized instanceof DomainError) {
    return error.localized;
  }
  return null;
}

/** Stored by background jobs beside the English, to render later; see `storedErrorMessage`. */
export type StoredErrorCode = { code: DomainErrorCode; params: DomainErrorParams };

export function storedErrorCode(error: unknown): StoredErrorCode | null {
  const domain = domainErrorOf(error);
  return domain ? { code: domain.code, params: domain.params } : null;
}
