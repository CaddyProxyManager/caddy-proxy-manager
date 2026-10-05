import { describe, expect, it } from 'bun:test';
import { uuidv7 } from '../../src/lib/db/uuidv7';

describe('uuidv7', () => {
  it('is an RFC 9562 version 7, variant 10 UUID', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('leads with the millisecond timestamp, so later ids sort after earlier ones', () => {
    const at = Date.UTC(2026, 8, 27, 12, 0, 0, 123);
    const id = uuidv7(at);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at);
    expect(uuidv7(at) < uuidv7(at + 1)).toBe(true);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(0)));
    expect(ids.size).toBe(1000);
  });
});
