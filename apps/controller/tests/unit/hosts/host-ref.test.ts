/** A host in a URL is its uuid; a serial id is not a reference. */
import { describe, it, expect } from 'bun:test';
import { parseHostUuid } from '../../../src/lib/hosts/ref';

describe('parseHostUuid', () => {
  it('lowercases a uuid', () => {
    expect(parseHostUuid('0198C2A4-1B2C-7D3E-8F4A-5B6C7D8E9F01')).toBe(
      '0198c2a4-1b2c-7d3e-8f4a-5b6c7d8e9f01',
    );
  });

  it.each(['', '42', '12abc', 'not-a-uuid', '0198c2a4-1b2c-7d3e-8f4a'])('refuses %p', (raw) => {
    expect(parseHostUuid(raw)).toBeNull();
  });
});
