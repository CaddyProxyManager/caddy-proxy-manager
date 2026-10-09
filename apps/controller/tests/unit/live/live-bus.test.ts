/** "Something changed" reaches this process's listeners at most once a second per topic, never lost. */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  LIVE_MIN_GAP_MS,
  publishLive,
  resetLiveBus,
  subscribeLive,
} from '../../../src/lib/live/bus';
import { isLiveTopic } from '../../../src/lib/live/topics';

beforeEach(() => resetLiveBus());

describe('publishLive', () => {
  it('reaches a subscriber at once, and not after it unsubscribes', () => {
    let calls = 0;
    const stop = subscribeLive('analytics', () => calls++);
    publishLive('analytics', 10_000);
    expect(calls).toBe(1);
    stop();
    publishLive('analytics', 10_000 + LIVE_MIN_GAP_MS * 2);
    expect(calls).toBe(1);
  });

  it('keeps topics apart', () => {
    let analytics = 0;
    let waf = 0;
    subscribeLive('analytics', () => analytics++);
    subscribeLive('waf', () => waf++);
    publishLive('waf', 10_000);
    expect([analytics, waf]).toEqual([0, 1]);
  });

  it('collapses a burst into the first call and one trailing call', async () => {
    let calls = 0;
    subscribeLive('analytics', () => calls++);
    const start = Date.now();
    publishLive('analytics', start);
    publishLive('analytics', start + 10);
    publishLive('analytics', start + 20);
    expect(calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, LIVE_MIN_GAP_MS + 150));
    expect(calls).toBe(2);
  });
});

describe('isLiveTopic', () => {
  it('accepts what the page can ask for and nothing else', () => {
    expect(isLiveTopic('analytics')).toBe(true);
    expect(isLiveTopic('waf')).toBe(true);
    expect(isLiveTopic('users')).toBe(false);
    expect(isLiveTopic('')).toBe(false);
  });
});
