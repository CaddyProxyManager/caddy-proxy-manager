import { describe, expect, it } from 'bun:test';
import { type Health, waitForRestart } from '../../src/lib/runtime/restart-wait';

/** Health answers in order (the last one repeats), on a clock that only moves when polled. */
function scripted(answers: Health[]) {
  let clock = 0;
  let asked = 0;
  return {
    asked: () => asked,
    deps: {
      health: async () => answers[Math.min(asked++, answers.length - 1)],
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      pollMs: 1000,
      shutdownBudgetMs: 20_000,
      startupBudgetMs: 120_000,
    },
  };
}

const old = { up: true, boot: 'old' };
const fresh = { up: true, boot: 'new' };
const down = { up: false, boot: null };

describe('waitForRestart', () => {
  it('sees a restart that finished between two polls by its new boot id', async () => {
    const { deps } = scripted([old, fresh]);
    expect(await waitForRestart('old', deps)).toBe('restarted');
  });

  it('follows an ordinary down-then-up restart', async () => {
    const { deps } = scripted([old, old, down, down, fresh]);
    let wentDown = false;
    expect(await waitForRestart('old', { ...deps, onDown: () => (wentDown = true) })).toBe(
      'restarted',
    );
    expect(wentDown).toBe(true);
  });

  it('reports a process that never went away, boot id unchanged', async () => {
    const { deps } = scripted([old]);
    expect(await waitForRestart('old', deps)).toBe('stillRunning');
  });

  it('falls back to seeing an outage when the old boot id is unknown', async () => {
    expect(await waitForRestart(null, scripted([fresh]).deps)).toBe('stillRunning');
    expect(await waitForRestart(null, scripted([fresh, down, fresh]).deps)).toBe('restarted');
  });

  it('gives up when the process never comes back', async () => {
    const { deps } = scripted([old, down]);
    expect(await waitForRestart('old', deps)).toBe('notBack');
  });

  it('stops when the dialog goes away', async () => {
    const { deps } = scripted([old]);
    expect(await waitForRestart('old', { ...deps, cancelled: () => true })).toBeNull();
  });
});
