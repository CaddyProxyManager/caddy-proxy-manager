/** The traffic signal detectors, on rows as ClickHouse would return them. */
import { describe, expect, it } from 'bun:test';
import {
  type MinuteErrors,
  findMitigationSpikes,
  findServerErrorBursts,
} from '@/src/lib/analytics/signals';

const NOW = 1_800_000_000;
const NOW_MINUTE = Math.floor(NOW / 60);

const minute = (
  offset: number,
  requests: number,
  errors: number,
  host = 'a.example',
): MinuteErrors => ({
  host,
  minute: NOW_MINUTE + offset,
  requests,
  errors,
});

describe('findServerErrorBursts', () => {
  it('finds a burst of enough errors that are a large enough share', () => {
    const [burst] = findServerErrorBursts([minute(-30, 20, 6), minute(-29, 20, 6)], NOW);
    expect(burst).toMatchObject({
      kind: 'serverErrorBurst',
      host: 'a.example',
      errors: 12,
      requests: 40,
      share: 0.3,
      ongoing: false,
      severity: 'warning',
    });
    expect(burst!.from).toBe((NOW_MINUTE - 30) * 60);
    expect(burst!.to).toBe((NOW_MINUTE - 28) * 60);
  });

  it('needs at least ten errors', () => {
    expect(findServerErrorBursts([minute(-30, 10, 9)], NOW)).toEqual([]);
  });

  it('needs them to be at least a tenth of the requests', () => {
    expect(findServerErrorBursts([minute(-30, 1000, 50)], NOW)).toEqual([]);
  });

  it('joins runs across a gap of up to two minutes, not three', () => {
    const joined = findServerErrorBursts([minute(-30, 10, 5), minute(-27, 10, 5)], NOW);
    expect(joined).toHaveLength(1);
    const split = findServerErrorBursts([minute(-30, 10, 5), minute(-26, 10, 5)], NOW);
    expect(split).toEqual([]);
  });

  it('calls a burst with a 5xx in the last five minutes ongoing, and critical', () => {
    const [burst] = findServerErrorBursts([minute(-3, 20, 12)], NOW);
    expect(burst).toMatchObject({ ongoing: true, severity: 'critical' });
  });

  it('keeps hosts apart', () => {
    const bursts = findServerErrorBursts(
      [minute(-10, 20, 6, 'a.example'), minute(-10, 20, 6, 'b.example')],
      NOW,
    );
    expect(bursts).toEqual([]);
  });
});

describe('findMitigationSpikes', () => {
  const DAY = 86400;

  it('flags a window with three times its 7-day average and at least 50', () => {
    // 7 days at 10 a day is a baseline of 10 for a one-day window.
    const spikes = findMitigationSpikes([{ host: 'a.example', current: 60, baseline: 70 }], DAY);
    expect(spikes.map((spike) => spike.host)).toEqual([null, 'a.example']);
    expect(spikes[1]).toMatchObject({ mitigated: 60, baseline: 10, ratio: 6 });
  });

  it('ignores a spike under 50, however steep', () => {
    expect(findMitigationSpikes([{ host: 'a.example', current: 49, baseline: 0 }], DAY)).toEqual(
      [],
    );
  });

  it('ignores steady traffic', () => {
    expect(findMitigationSpikes([{ host: 'a.example', current: 100, baseline: 700 }], DAY)).toEqual(
      [],
    );
  });

  it('reports a spike from nothing with no ratio', () => {
    const [fleet] = findMitigationSpikes([{ host: 'a.example', current: 80, baseline: 0 }], DAY);
    expect(fleet).toMatchObject({ host: null, ratio: null, baseline: 0 });
  });

  it('sees a fleet-wide spike that no single host makes', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ host: `h${i}`, current: 20, baseline: 0 }));
    expect(findMitigationSpikes(rows, DAY).map((spike) => spike.host)).toEqual([null]);
  });
});
