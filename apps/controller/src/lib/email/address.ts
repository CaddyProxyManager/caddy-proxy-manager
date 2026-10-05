/**
 * Email syntax, deliberately loose: it only catches a typo before it is saved. Client-safe on
 * purpose - the form fields and the server check share it, so they cannot disagree.
 */

/** RFC 5321's limit on a whole path, which bounds the regex's input as well. */
const MAX_LENGTH = 320;

// Domain labels are matched one at a time, each excluding the dot that separates them. The
// obvious `[^\s@]+\.[^\s@]+` lets both sides consume dots, so the two alternatives overlap and a
// non-matching address backtracks quadratically -- CodeQL js/polynomial-redos.

/** Any domain, dotless included: setup names the first administrator `name@localhost`. */
const ACCOUNT_ADDRESS = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*$/;

/** A domain with at least one dot, which is what an ACME CA accepts as a contact. */
export const EMAIL_ADDRESS = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** `public` requires a dotted domain; `any` also accepts a single-label one such as `localhost`. */
export type EmailDomain = "any" | "public";

export function isEmailAddress(value: string, domain: EmailDomain = "any"): boolean {
  if (value.length > MAX_LENGTH) return false;
  return (domain === "public" ? EMAIL_ADDRESS : ACCOUNT_ADDRESS).test(value);
}
