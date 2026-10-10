/**
 * Model errors a person reads. Models run for actions, `/api/v1/*` and the agent's sync, and only
 * actions have a reader's language: so a code plus an English sentence, which REST keeps returning.
 */

// Named, so a client bundle carries this namespace and not the whole catalog.
import { errors as englishErrors } from "../../../messages/en.json";

export type DomainErrorCode = keyof typeof englishErrors;

type CodedSentence = { code: DomainErrorCode; params: Record<string, string | number> };

/**
 * One item of a list param that is itself a sentence: rendered from its own code, after the quoted
 * `line` it is about when there is one (`errors.quotedReason`). A `cause` renders into `{reason}`.
 */
export type DomainErrorDetail = CodedSentence & { line?: string; cause?: CodedSentence };

/** A list is joined with ", " in English; `extractErrorMessage` list-formats it for a reader. */
export type DomainErrorParams = Record<
  string,
  string | number | readonly string[] | readonly DomainErrorDetail[]
>;

export function isDetailList(
  value: DomainErrorParams[string],
): value is readonly DomainErrorDetail[] {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === "object";
}

/** How a detail list reads, given how one code renders; shared by English and a reader's language. */
export function renderDetails(
  details: readonly DomainErrorDetail[],
  render: (code: DomainErrorCode, params: Record<string, string | number>) => string,
): string[] {
  return details.map((detail) => {
    const params = detail.cause
      ? { ...detail.params, reason: render(detail.cause.code, detail.cause.params) }
      : detail.params;
    const reason = render(detail.code, params);
    return detail.line === undefined
      ? reason
      : render("quotedReason", { line: detail.line, reason });
  });
}

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

/**
 * The ICU plural forms next-intl renders, in English: `{count, plural, one {# line} other {# lines}}`,
 * with `=N` exact matches, so a catalog sentence can count without a `(s)`. Nothing else of ICU:
 * a selects or nesting is for the real formatter, which every reader with a language gets.
 */
function renderPlural(count: number, forms: string): string {
  const options = new Map<string, string>();
  let i = 0;
  while (i < forms.length) {
    const open = forms.indexOf("{", i);
    if (open < 0) break;
    const key = forms.slice(i, open).trim();
    let depth = 0;
    let close = open;
    for (; close < forms.length; close++) {
      if (forms[close] === "{") depth++;
      else if (forms[close] === "}" && --depth === 0) break;
    }
    options.set(key, forms.slice(open + 1, close));
    i = close + 1;
  }
  const chosen =
    options.get(`=${count}`) ??
    (count === 1 ? options.get("one") : undefined) ??
    options.get("other");
  return (chosen ?? "").replaceAll("#", String(count));
}

const PLURAL_PATTERN = /\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g;

export function domainErrorMessage(code: DomainErrorCode, params: DomainErrorParams = {}): string {
  return englishErrors[code]
    .replace(PLURAL_PATTERN, (whole, name: string, forms: string) => {
      const value = params[name];
      return typeof value === "number" ? renderPlural(value, forms) : whole;
    })
    .replace(/\{(\w+)\}/g, (whole, name: string) => {
      if (!(name in params)) return whole;
      const value = params[name];
      if (isDetailList(value)) return renderDetails(value, domainErrorMessage).join(", ");
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
