/**
 * Passwords the app chooses. `crypto.getRandomValues` only, so it runs in the browser too; never
 * `Math.random`, whose output is recoverable from a handful of samples.
 */
import { MIN_PASSWORD_LENGTH, isPasswordAcceptable } from "./password-policy";

/**
 * No I, l, 1, O, 0: one nobody can transcribe gets replaced by a weak one. The symbols survive a
 * shell, YAML and a connection string unquoted.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#%&*-_=+";

/** Past the policy minimum, still short enough to read aloud. */
export const GENERATED_PASSWORD_LENGTH = 24;

/** Rejection-sampled: 2^32 is not a multiple of the alphabet size, so a bare modulo is biased. */
function randomString(length: number): string {
  const ceiling = Math.floor(0x1_0000_0000 / ALPHABET.length) * ALPHABET.length;
  const out: string[] = [];
  const draws = new Uint32Array(length * 2);

  while (out.length < length) {
    crypto.getRandomValues(draws);
    for (const draw of draws) {
      if (out.length === length) break;
      if (draw < ceiling) out.push(ALPHABET[draw % ALPHABET.length]);
    }
  }

  return out.join("");
}

/**
 * Discards candidates rather than composing one character per class: composing is biased, and
 * stops matching the policy the day a rule is added. Rejection asks {@link isPasswordAcceptable}.
 */
export function generatePassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  if (length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `generatePassword: ${length} is below the policy minimum of ${MIN_PASSWORD_LENGTH}`,
    );
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = randomString(length);
    if (isPasswordAcceptable(candidate)) return candidate;
  }

  // Unreachable with this alphabet; loud rather than return a password the form rejects.
  throw new Error("generatePassword: exhausted attempts without meeting the password policy");
}
