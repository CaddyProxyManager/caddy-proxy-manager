/**
 * The generator hands out credentials, so the properties worth pinning are the ones whose failure
 * is silent: a password the policy rejects, a biased draw, or a fall back to Math.random.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { GENERATED_PASSWORD_LENGTH, generatePassword } from '@/src/lib/auth/password/generator';
import { MIN_PASSWORD_LENGTH, isPasswordAcceptable } from '@/src/lib/auth/password/policy';

describe('generatePassword', () => {
  it('always returns a password the policy accepts', () => {
    // The interesting case is the rare candidate that misses a character class. One run in a
    // thousand fails at the default length, so a single sample would pass with a broken loop.
    for (let i = 0; i < 2_000; i++) {
      expect(isPasswordAcceptable(generatePassword())).toBe(true);
    }
  });

  it('returns the requested length', () => {
    expect(generatePassword()).toHaveLength(GENERATED_PASSWORD_LENGTH);
    expect(generatePassword(MIN_PASSWORD_LENGTH)).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(generatePassword(64)).toHaveLength(64);
  });

  it('refuses a length the policy could never accept', () => {
    // Rather than looping to the attempt cap and throwing something less specific.
    expect(() => generatePassword(MIN_PASSWORD_LENGTH - 1)).toThrow(/below the policy minimum/);
    expect(() => generatePassword(0)).toThrow(/below the policy minimum/);
  });

  it('draws from crypto.getRandomValues, not Math.random', () => {
    // The substitution this guards against is silent: Math.random produces something that looks
    // exactly as random until someone tries to predict it.
    const crypto_ = spyOn(globalThis.crypto, 'getRandomValues');
    const math = spyOn(Math, 'random');
    try {
      generatePassword();
      expect(crypto_).toHaveBeenCalled();
      expect(math).not.toHaveBeenCalled();
    } finally {
      crypto_.mockRestore();
      math.mockRestore();
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });

  it('leaves out glyphs that cannot be told apart when transcribed', () => {
    const sample = Array.from({ length: 200 }, () => generatePassword(32)).join('');
    for (const ambiguous of ['I', 'l', '1', 'O', '0']) {
      expect(sample).not.toContain(ambiguous);
    }
  });

  it('spreads characters evenly across the alphabet', () => {
    // A modulo bias is too small to see here; this catches a coarse mistake - a truncated alphabet,
    // a draw folded into too small a range - that would skew the distribution visibly.
    const sample = Array.from({ length: 4_000 }, () => generatePassword(32)).join('');
    const counts = new Map<string, number>();
    for (const character of sample) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }

    const frequencies = [...counts.values()];
    const expected = sample.length / counts.size;
    // Every character appears, and none is wildly over- or under-represented.
    expect(counts.size).toBeGreaterThan(60);
    expect(Math.min(...frequencies)).toBeGreaterThan(expected * 0.8);
    expect(Math.max(...frequencies)).toBeLessThan(expected * 1.2);
  });
});
