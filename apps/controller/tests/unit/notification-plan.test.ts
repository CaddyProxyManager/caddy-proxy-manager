/** The notification state machine, with `now` injected: dedupe, quiet periods, batches, retries. */
import { describe, expect, it } from 'bun:test';
import {
  BATCH_MS,
  EMPTY_STATE,
  MAX_PENDING,
  MAX_PENDING_AGE_MS,
  normalizeState,
  planBatch,
  planDropped,
  planFailure,
  planNotice,
  planRaise,
  planResolve,
  planSendFailed,
  planSent,
  planSuccess,
  RETRY_MS,
} from '@/src/lib/notifications/plan';
import type { NotificationEvent } from '@/src/lib/notifications/events';

const T0 = Date.parse('2026-09-29T12:00:00Z');
const OFFLINE: NotificationEvent = { kind: 'agentOffline', agent: 'edge', minutes: 5 };
const ONLINE: NotificationEvent = { kind: 'agentOnline', agent: 'edge' };
let counter = 0;
const id = () => `n${++counter}`;
const kinds = (state: typeof EMPTY_STATE) => state.pending.map((notice) => notice.event.kind);

describe('problems', () => {
  it('tells once however often a problem is raised, then its recovery once', () => {
    let state = planRaise(EMPTY_STATE, 'agent:1', OFFLINE, T0, id());
    expect(planRaise(state, 'agent:1', OFFLINE, T0 + 1, id())).toBe(state);

    const picked = planBatch(state, T0 + BATCH_MS);
    expect(picked?.batch.map((notice) => notice.event)).toEqual([OFFLINE]);
    state = planSent(
      picked!.state,
      picked!.batch.map((notice) => notice.id),
      T0 + BATCH_MS,
    );
    expect(state.pending).toEqual([]);
    expect(state.open['agent:1'].noticeId).toBeNull();

    state = planResolve(state, 'agent:1', ONLINE, T0 + 2 * BATCH_MS, id());
    expect(kinds(state)).toEqual(['agentOnline']);
    expect(planResolve(state, 'agent:1', ONLINE, T0, id())).toBe(state);
  });

  it('withdraws an alert still waiting for its batch, and sends neither', () => {
    let state = planRaise(EMPTY_STATE, 'agent:1', OFFLINE, T0, id());
    state = planResolve(state, 'agent:1', ONLINE, T0 + 1_000, id());
    expect(state.pending).toEqual([]);
    expect(state.open).toEqual({});
  });

  it('withdraws only the new alert when a told problem comes back before its recovery is sent', () => {
    let state = planRaise(EMPTY_STATE, 'k', OFFLINE, T0, id());
    const picked = planBatch(state, T0 + BATCH_MS)!;
    state = planSent(
      picked.state,
      picked.batch.map((notice) => notice.id),
      T0 + BATCH_MS,
    );
    state = planResolve(state, 'k', ONLINE, T0 + BATCH_MS + 1, id());
    state = planRaise(state, 'k', OFFLINE, T0 + BATCH_MS + 2, id());
    state = planResolve(state, 'k', ONLINE, T0 + BATCH_MS + 3, id());
    expect(kinds(state)).toEqual(['agentOnline']);
  });

  it('raises a job failure only once the streak reaches the threshold, and clears it on success', () => {
    const failed = (failures: number): NotificationEvent => ({
      kind: 'geoipFailed',
      failures,
      error: 'HTTP 401',
    });
    let state = EMPTY_STATE;
    for (let i = 0; i < 2; i++) state = planFailure(state, 'geoip', 3, failed, T0, id());
    expect(state.pending).toEqual([]);
    state = planFailure(state, 'geoip', 3, failed, T0, id());
    expect(state.pending.map((notice) => notice.event)).toEqual([failed(3)]);
    state = planFailure(state, 'geoip', 3, failed, T0, id());
    expect(state.pending).toHaveLength(1);

    const picked = planBatch(state, T0 + BATCH_MS)!;
    state = planSent(
      picked.state,
      picked.batch.map((notice) => notice.id),
      T0 + BATCH_MS,
    );
    state = planSuccess(state, 'geoip', { kind: 'geoipRecovered' }, T0 + BATCH_MS, id());
    expect(kinds(state)).toEqual(['geoipRecovered']);
    expect(state.streaks).toEqual({});
    expect(planSuccess(state, 'geoip', { kind: 'geoipRecovered' }, T0, id())).toBe(state);
  });
});

describe('one-off notices', () => {
  const event: NotificationEvent = { kind: 'adminLocked', email: 'a@example.com', failures: 6 };

  it('stay quiet for their period, and "forever" for good', () => {
    let state = planNotice(EMPTY_STATE, { key: 'lock:1', event, quietMs: 60_000 }, T0, id());
    expect(planNotice(state, { key: 'lock:1', event, quietMs: 60_000 }, T0 + 59_000, id())).toBe(
      state,
    );
    state = planNotice(state, { key: 'lock:1', event, quietMs: 60_000 }, T0 + 60_000, id());
    expect(state.pending).toHaveLength(2);

    const update: NotificationEvent = {
      kind: 'updateAvailable',
      version: '3.1.0',
      current: '3.0.0',
    };
    state = planNotice(state, { key: 'update:3.1.0', event: update, quietMs: 'forever' }, T0, id());
    const later = T0 + 365 * 86_400_000;
    expect(
      planNotice(state, { key: 'update:3.1.0', event: update, quietMs: 'forever' }, later, id()),
    ).toBe(state);
  });

  it('are never deduplicated with a quiet period of 0', () => {
    let state = EMPTY_STATE;
    for (let i = 0; i < 3; i++)
      state = planNotice(state, { key: 'k', event, quietMs: 0 }, T0, id());
    expect(state.pending).toHaveLength(3);
    expect(state.quiet).toEqual({});
  });
});

describe('batches', () => {
  it('wait for the oldest notice to be a minute old, and take everything queued since', () => {
    let state = planRaise(EMPTY_STATE, 'a', OFFLINE, T0, id());
    state = planRaise(state, 'b', { ...OFFLINE, agent: 'core' }, T0 + 30_000, id());
    expect(planBatch(state, T0 + BATCH_MS - 1)).toBeNull();
    expect(planBatch(state, T0 + BATCH_MS)?.batch).toHaveLength(2);
    expect(planBatch(EMPTY_STATE, T0)).toBeNull();
  });

  it('keep a failed send for a retry after RETRY_MS, with the error', () => {
    let state = planRaise(EMPTY_STATE, 'a', OFFLINE, T0, id());
    const picked = planBatch(state, T0 + BATCH_MS)!;
    state = planSendFailed(picked.state, '421 try later', T0 + BATCH_MS);
    expect(state.lastError).toBe('421 try later');
    expect(state.pending).toHaveLength(1);
    expect(planBatch(state, T0 + BATCH_MS + RETRY_MS - 1)).toBeNull();

    const retry = planBatch(state, T0 + BATCH_MS + RETRY_MS)!;
    state = planSent(
      retry.state,
      retry.batch.map((notice) => notice.id),
      T0 + BATCH_MS + RETRY_MS,
    );
    expect(state.lastError).toBeNull();
    expect(state.retryAt).toBeNull();
    expect(state.lastSentAt).toBe(new Date(T0 + BATCH_MS + RETRY_MS).toISOString());
  });

  it('drop notices a day old, and keep the queue bounded', () => {
    let state = planRaise(EMPTY_STATE, 'a', OFFLINE, T0, id());
    const stale = planBatch(state, T0 + MAX_PENDING_AGE_MS)!;
    expect(stale.batch).toEqual([]);
    expect(stale.state.pending).toEqual([]);

    state = EMPTY_STATE;
    for (let i = 0; i < MAX_PENDING + 5; i++) {
      state = planNotice(state, { key: `k${i}`, event: ONLINE, quietMs: 0 }, T0 + i, `id${i}`);
    }
    expect(state.pending).toHaveLength(MAX_PENDING);
    expect(state.pending[0].id).toBe('id5');
  });

  it('record a batch dropped for want of recipients', () => {
    const state = planRaise(EMPTY_STATE, 'a', OFFLINE, T0, 'x');
    const dropped = planDropped(state, ['x'], T0, 'noRecipients');
    expect(dropped.pending).toEqual([]);
    expect(dropped.lastErrorCode).toBe('noRecipients');
    expect(planDropped(state, [], T0, null)).toBe(state);
  });
});

describe('normalizeState', () => {
  it('reads a missing or damaged row as empty, and keeps what is well formed', () => {
    expect(normalizeState(null)).toEqual(EMPTY_STATE);
    expect(normalizeState('nonsense')).toEqual(EMPTY_STATE);
    const state = planRaise(EMPTY_STATE, 'a', OFFLINE, T0, 'x');
    const damaged = { ...state, pending: [...state.pending, { id: 1 }], lastErrorCode: 'what' };
    expect(normalizeState(JSON.parse(JSON.stringify(damaged)))).toEqual(state);
  });
});
