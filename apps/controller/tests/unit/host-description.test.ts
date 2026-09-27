import { describe, expect, it } from 'bun:test';
import { normalizeHostDescription } from '../../src/lib/host-description';
import { HOST_DESCRIPTION_MAX_LENGTH } from '../../src/lib/host-description-limit';
import { DomainError } from '../../src/lib/domain-error';

describe('normalizeHostDescription', () => {
  it('leaves an absent value alone and clears a blank one', () => {
    expect(normalizeHostDescription(undefined)).toBeUndefined();
    expect(normalizeHostDescription(null)).toBeNull();
    expect(normalizeHostDescription('   ')).toBeNull();
  });

  it('trims what it keeps', () => {
    expect(normalizeHostDescription('  Media stack, ask Sam  ')).toBe('Media stack, ask Sam');
  });

  it('counts graphemes, the way the editor does', () => {
    // Each family emoji is several code units but one character on screen.
    const emoji = '👨‍👩‍👧'.repeat(HOST_DESCRIPTION_MAX_LENGTH);
    expect(normalizeHostDescription(emoji)).toBe(emoji);
  });

  it('refuses anything over the limit with a 400', () => {
    try {
      normalizeHostDescription('x'.repeat(HOST_DESCRIPTION_MAX_LENGTH + 1));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('hostDescriptionTooLong');
      expect((error as DomainError).status).toBe(400);
    }
  });
});
