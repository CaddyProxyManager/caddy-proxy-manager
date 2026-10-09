import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { analyticsErrorResponse } from '@/src/lib/analytics/api-error';
import {
  ANALYTICS_STARTING,
  ANALYTICS_STARTUP_GRACE_MS,
  analyticsStarting,
} from '@/src/lib/analytics/starting';

const refused = Object.assign(new Error('connect ECONNREFUSED 172.22.0.3:8123'), {
  code: 'ECONNREFUSED',
});

describe('analyticsStarting', () => {
  it('reads a refused connection just after startup as ClickHouse still coming up', () => {
    expect(analyticsStarting(refused, 10_000)).toBe(true);
  });

  it('reports it as a fault once the grace period is over', () => {
    expect(analyticsStarting(refused, ANALYTICS_STARTUP_GRACE_MS)).toBe(false);
  });

  it('never covers an error that is not a connection failure', () => {
    expect(analyticsStarting(new Error('Syntax error: failed at position 1'), 10_000)).toBe(false);
  });
});

describe('analyticsErrorResponse', () => {
  // The full suite outlives the grace period, so the process's age is pinned.
  const uptime = spyOn(process, 'uptime').mockReturnValue(10);
  afterEach(() => uptime.mockReturnValue(10));

  it('answers 503 with the code the pages look for', async () => {
    const response = analyticsErrorResponse(refused);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: ANALYTICS_STARTING });
  });

  it('leaves any other error to apiErrorResponse', () => {
    expect(analyticsErrorResponse(new Error('boom')).status).toBe(500);
  });

  it('is an ordinary failure once the controller has been up a while', () => {
    uptime.mockReturnValue(ANALYTICS_STARTUP_GRACE_MS / 1000);
    expect(analyticsErrorResponse(refused).status).not.toBe(503);
  });
});
