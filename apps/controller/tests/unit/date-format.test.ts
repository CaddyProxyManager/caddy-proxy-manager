import { describe, expect, it } from 'bun:test';
import { formatUtc, fromZonedWallTime, toZonedWallTime } from '@/src/lib/date-format';

describe('formatUtc', () => {
  it('writes the instant the way logs record it, whatever the runtime locale', () => {
    expect(formatUtc(Date.UTC(2026, 8, 3, 10, 45, 9))).toBe('2026-09-03 10:45:09 UTC');
  });

  it('accepts ISO strings and Date objects', () => {
    expect(formatUtc('2026-09-03T00:00:00Z')).toBe('2026-09-03 00:00:00 UTC');
    expect(formatUtc(new Date('2026-09-03T23:59:59.999Z'))).toBe('2026-09-03 23:59:59 UTC');
  });

  it('gives back an unparseable value unchanged rather than "Invalid Date"', () => {
    expect(formatUtc('not a date')).toBe('not a date');
  });
});

describe('wall-clock values in a time zone', () => {
  const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  it('reads a picker value as local time in the named zone', () => {
    // New York is on DST in May, UTC-4.
    expect(fromZonedWallTime('2026-05-01T09:00', 'America/New_York')).toBe(
      unix('2026-05-01T13:00:00Z'),
    );
    expect(fromZonedWallTime('2026-05-01T09:00', 'UTC')).toBe(unix('2026-05-01T09:00:00Z'));
    expect(fromZonedWallTime('2026-01-15T12:30', 'Asia/Kolkata')).toBe(
      unix('2026-01-15T07:00:00Z'),
    );
  });

  it('writes a unix time back as the same wall clock', () => {
    const ts = unix('2026-11-20T15:45:00Z');
    expect(toZonedWallTime(ts, 'Europe/Berlin')).toBe('2026-11-20T16:45');
    expect(fromZonedWallTime(toZonedWallTime(ts, 'Europe/Berlin'), 'Europe/Berlin')).toBe(ts);
  });

  it('uses the offset in force on the day, across a daylight saving change', () => {
    // Berlin moves from UTC+2 to UTC+1 on 2026-10-25.
    expect(fromZonedWallTime('2026-10-24T12:00', 'Europe/Berlin')).toBe(
      unix('2026-10-24T10:00:00Z'),
    );
    expect(fromZonedWallTime('2026-10-26T12:00', 'Europe/Berlin')).toBe(
      unix('2026-10-26T11:00:00Z'),
    );
  });

  it('refuses anything that is not a wall-clock value', () => {
    expect(fromZonedWallTime('', 'UTC')).toBeNull();
    expect(fromZonedWallTime('2026-05-01', 'UTC')).toBeNull();
    expect(fromZonedWallTime('yesterday', 'UTC')).toBeNull();
  });
});
