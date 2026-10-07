/** A digest's time of day as cron, read in its own zone across daylight-saving changes. */
import { describe, expect, it } from 'bun:test';
import { digestCron } from '@/src/lib/alerts/digests';
import { type CronFactory, latestSlot, nextRun, scheduleJobs } from '@/src/lib/cron';

const at = (iso: string) => Date.parse(iso);

describe('digest timing', () => {
  it('turns a time of day into a daily expression', () => {
    expect(digestCron('08:00')).toBe('0 8 * * *');
    expect(digestCron('23:05')).toBe('5 23 * * *');
  });

  it('fires at the same local time on both sides of a daylight-saving change', () => {
    const cron = digestCron('08:00');
    // Berlin leaves summer time on 25 October 2026: 08:00 is 06:00 UTC before, 07:00 after.
    expect(nextRun(cron, 'Europe/Berlin', at('2026-10-24T05:00:00Z'))).toBe(
      at('2026-10-24T06:00:00Z'),
    );
    expect(nextRun(cron, 'Europe/Berlin', at('2026-10-24T06:00:00Z'))).toBe(
      at('2026-10-25T07:00:00Z'),
    );
    // And enters it on 28 March 2027.
    expect(nextRun(cron, 'Europe/Berlin', at('2027-03-27T08:00:00Z'))).toBe(
      at('2027-03-28T06:00:00Z'),
    );
    // New York leaves it on 1 November 2026.
    expect(nextRun(cron, 'America/New_York', at('2026-10-31T13:00:00Z'))).toBe(
      at('2026-11-01T13:00:00Z'),
    );
    expect(latestSlot(cron, 'Europe/Berlin', at('2026-10-25T09:00:00Z'))).toBe(
      at('2026-10-25T07:00:00Z'),
    );
  });

  it("gives Bun.cron the digest's zone", () => {
    const made: { expression: string; tz: string }[] = [];
    const fake: CronFactory = (expression, _handler, options) => {
      made.push({ expression, tz: options.tz });
      return { stop() {}, unref() {} };
    };
    const { failed } = scheduleJobs(
      [{ id: 1, name: 'daily', cron: digestCron('07:30'), timeZone: 'Asia/Tokyo' }],
      () => async () => {},
      fake,
      'alerts',
    );
    expect(failed).toEqual([]);
    expect(made).toEqual([{ expression: '30 7 * * *', tz: 'Asia/Tokyo' }]);
  });
});
