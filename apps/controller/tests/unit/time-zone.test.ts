import { describe, expect, it } from 'bun:test';
import { parseTimeZone, resolveTimeZone } from '@/src/lib/locale/time-zone';

describe('time zone cookie', () => {
  it('accepts an IANA zone the runtime knows', () => {
    expect(parseTimeZone('America/New_York')).toBe('America/New_York');
    expect(parseTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(parseTimeZone('UTC')).toBe('UTC');
  });

  it('refuses what Intl would throw on, or what was never a zone name', () => {
    expect(parseTimeZone('Mars/Olympus_Mons')).toBeUndefined();
    expect(parseTimeZone('America/New_York; path=/')).toBeUndefined();
    expect(parseTimeZone('<script>')).toBeUndefined();
    expect(parseTimeZone('a'.repeat(65))).toBeUndefined();
    expect(parseTimeZone('')).toBeUndefined();
    expect(parseTimeZone(undefined)).toBeUndefined();
  });

  it('renders in UTC until a real zone has been recorded', () => {
    expect(resolveTimeZone(undefined)).toBe('UTC');
    expect(resolveTimeZone('Nowhere/Special')).toBe('UTC');
    expect(resolveTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  });
});
