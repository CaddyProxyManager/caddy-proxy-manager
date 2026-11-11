import { describe, expect, it } from 'bun:test';
import { constantTimeEqual } from '@/src/lib/security/constant-time';

describe('constantTimeEqual', () => {
  it('matches equal strings and buffers', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
    expect(constantTimeEqual(Buffer.from('ab', 'hex'), Buffer.from('ab', 'hex'))).toBe(true);
  });

  it('refuses a different value of the same length', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
  });

  it('refuses a different length instead of throwing', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  // Same `.length`, different UTF-8 width: the case a raw timingSafeEqual threw on.
  it('refuses a multibyte value of the same character count', () => {
    expect(constantTimeEqual('é', 'e')).toBe(false);
  });
});
