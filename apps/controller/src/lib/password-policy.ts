/**
 * The password policy. Dependency-free, so config.ts and client components share it. Codes, not
 * sentences: not every language puts the subject first; password-policy-message.ts renders them.
 */

export const MIN_PASSWORD_LENGTH = 12;

/** One per rule, in the order they are reported. */
export type PasswordPolicyViolation = "length" | "case" | "number" | "special";

/** Empty means acceptable. */
export function passwordPolicyViolations(password: string): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    violations.push("length");
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
    violations.push("case");
  }
  if (!/[0-9]/.test(password)) {
    violations.push("number");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    violations.push("special");
  }

  return violations;
}

export function isPasswordAcceptable(password: string): boolean {
  return passwordPolicyViolations(password).length === 0;
}
