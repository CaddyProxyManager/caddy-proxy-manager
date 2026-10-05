/**
 * Apart from `auth/password/policy.ts` so that stays a dependency-free predicate, and shared because
 * four screens report the rule.
 */

import en from "../../../../messages/en.json";
import {
  MIN_PASSWORD_LENGTH,
  type PasswordPolicyViolation,
  passwordPolicyViolations,
} from "./policy";

type PolicyKey =
  | "passwordPolicy.hint"
  | "passwordPolicy.error"
  | `passwordPolicy.violation.${PasswordPolicyViolation}`;

/**
 * Not next-intl's translator type, which would drag the package into `config.ts`'s startup graph.
 * An unscoped `useTranslations()` or `getTranslations()` satisfies it.
 */
type Translate = (key: PolicyKey, values?: Record<string, string | number>) => string;

function violationKey(violation: PasswordPolicyViolation): PolicyKey {
  return `passwordPolicy.violation.${violation}`;
}

export function passwordPolicyHint(t: Translate): string {
  return t("passwordPolicy.hint", { min: MIN_PASSWORD_LENGTH });
}

/**
 * Every failure in one sentence, so a retry teaches the whole rule; null when it passes. `subject`
 * is the caller's translated field name, since each form names it differently.
 */
export function passwordPolicyMessage(
  t: Translate,
  password: string,
  subject: string,
): string | null {
  const violations = passwordPolicyViolations(password);
  if (violations.length === 0) return null;

  const failures = violations
    .map((violation) => t(violationKey(violation), { min: MIN_PASSWORD_LENGTH }))
    .join(", ");

  return t("passwordPolicy.error", { subject, failures });
}

/**
 * For `config.ts`, which validates ADMIN_PASSWORD before any request has a locale. Read from the
 * catalog rather than repeated, so the two cannot drift.
 */
export function passwordPolicyViolationsInEnglish(password: string): string[] {
  return passwordPolicyViolations(password).map((violation) =>
    en.passwordPolicy.violation[violation].replace("{min}", String(MIN_PASSWORD_LENGTH)),
  );
}
