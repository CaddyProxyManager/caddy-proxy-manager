import { describe, expect, it } from 'bun:test';
import { strictId } from '@/src/lib/http/strict-id';

describe('strictId', () => {
  it('reads a plain id', () => {
    expect(strictId('942100')).toBe(942100);
    expect(strictId(' 7 ')).toBe(7);
  });

  it('refuses what parseInt would half-read', () => {
    for (const value of ['942100x', '12.5', '-3', '1e3', '0x10', '', '   ', undefined]) {
      expect(strictId(value)).toBeUndefined();
    }
  });

  it('refuses an id past the safe integer range', () => {
    expect(strictId('9007199254740993')).toBeUndefined();
  });
});
