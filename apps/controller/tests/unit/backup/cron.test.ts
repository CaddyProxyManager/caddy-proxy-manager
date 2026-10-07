import { describe, expect, it } from 'bun:test';
import {
  cronProblem,
  isOverdue,
  latestSlot,
  missedSlot,
  nextRun,
  presetExpression,
  presetOf,
} from '../../../src/lib/backup/cron';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-10-06T12:34:56Z');

describe('cron validation', () => {
  it('refuses bad syntax, an unknown zone and a never-firing expression, each by its own code', () => {
    expect(cronProblem('not a cron', 'UTC', NOW)).toBe('backupCronInvalid');
    expect(cronProblem('61 * * * *', 'UTC', NOW)).toBe('backupCronInvalid');
    expect(cronProblem('0 2 * * *', 'Mars/Olympus_Mons', NOW)).toBe('backupTimeZoneInvalid');
    // February 30th: valid syntax, no occurrence ever.
    expect(cronProblem('0 0 30 2 *', 'UTC', NOW)).toBe('backupCronNeverFires');
    expect(cronProblem('0 2 * * *', 'Europe/Berlin', NOW)).toBeNull();
  });

  it('agrees with Bun.cron.parse on the next run, across a daylight-saving change', () => {
    // US clocks go forward on 2026-03-08: 01:30 New York is 06:30Z before and 05:30Z after.
    let from = at('2026-03-06T12:00:00Z');
    const runs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const next = nextRun('30 1 * * *', 'America/New_York', from);
      const parsed = Bun.cron.parse('30 1 * * *', new Date(from), { tz: 'America/New_York' });
      expect(next).toBe(parsed?.getTime() ?? null);
      runs.push(new Date(next as number).toISOString());
      from = next as number;
    }
    expect(runs).toEqual([
      '2026-03-07T06:30:00.000Z',
      '2026-03-08T06:30:00.000Z',
      '2026-03-09T05:30:00.000Z',
      '2026-03-10T05:30:00.000Z',
    ]);
  });
});

describe('presets', () => {
  it('maps each preset to its expression and back', () => {
    const cases = [
      [{ kind: 'hourly', minute: 15 }, '15 * * * *'],
      [{ kind: 'daily', hour: 3, minute: 30 }, '30 3 * * *'],
      [{ kind: 'weekly', weekday: 0, hour: 4, minute: 0 }, '0 4 * * 0'],
      [{ kind: 'custom', expression: ' 0 */6 * * * ' }, '0 */6 * * *'],
    ] as const;
    for (const [preset, expression] of cases) {
      expect(presetExpression(preset)).toBe(expression);
      expect(presetOf(expression)).toEqual(
        preset.kind === 'custom' ? { kind: 'custom', expression } : preset,
      );
    }
  });
});

describe('slots and catch-up', () => {
  const daily = { cron: '0 2 * * *', timeZone: 'UTC' };

  it('finds the latest slot at or before a time, including the time itself', () => {
    expect(latestSlot('0 2 * * *', 'UTC', NOW)).toBe(at('2026-10-06T02:00:00Z'));
    expect(latestSlot('0 2 * * *', 'UTC', at('2026-10-06T02:00:00Z'))).toBe(
      at('2026-10-06T02:00:00Z'),
    );
    expect(latestSlot('*/5 * * * *', 'UTC', NOW)).toBe(at('2026-10-06T12:30:00Z'));
    expect(latestSlot('0 0 1 1 *', 'UTC', NOW)).toBe(at('2026-01-01T00:00:00Z'));
  });

  it('runs exactly the one missed slot, however many were missed', () => {
    // Last ran three days ago: only today's 02:00 is owed.
    expect(missedSlot(daily, at('2026-10-03T02:00:00Z'), NOW)).toBe(at('2026-10-06T02:00:00Z'));
  });

  it('owes nothing when the latest slot already ran, or predates the schedule', () => {
    expect(missedSlot(daily, at('2026-10-06T02:00:00Z'), NOW)).toBeNull();
    expect(missedSlot(daily, at('2026-10-06T09:00:00Z'), NOW)).toBeNull();
  });

  it('calls a schedule overdue only once two slots have passed without a run', () => {
    const since = at('2026-09-01T00:00:00Z');
    expect(isOverdue(daily, since, at('2026-10-06T02:00:00Z'), NOW)).toBe(false);
    expect(isOverdue(daily, since, at('2026-10-05T02:00:00Z'), NOW)).toBe(false);
    expect(isOverdue(daily, since, at('2026-10-04T02:00:00Z'), NOW)).toBe(true);
    expect(isOverdue(daily, since, null, NOW)).toBe(true);
    // Created yesterday afternoon: only one slot has come since.
    expect(isOverdue(daily, at('2026-10-05T15:00:00Z'), null, NOW)).toBe(false);
  });
});
