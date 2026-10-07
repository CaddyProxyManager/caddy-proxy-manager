/**
 * What lets a second controller share the database: spent nonces, the startup and leader locks,
 * replica registration and cache announcements. The locks and LISTEN are PostgreSQL's own, so
 * those run against the test server through the app's connection and skip under SQLite.
 */
import { SQL } from 'bun';
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

// A NOTIFY can take seconds to arrive on a loaded CI runner, past Bun's 5s default.
setDefaultTimeout(20_000);

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
const { claimNonce, isNonceSpent, pruneSpentNonces } = await import(
  '../../../src/lib/cluster/nonces'
);
const {
  announce,
  onAnnouncement,
  registerReplica,
  ReplicaKeyMismatchError,
  runAsLeader,
  isLeader,
} = await import('../../../src/lib/cluster');
const { catchUpOnAnnouncements } = await import('../../../src/lib/cluster/announcements');
const { listenForMessages, onClusterMessage, stopListening } = await import(
  '../../../src/lib/cluster/bus'
);
const { contendForLeadership, resignLeadership } = await import('../../../src/lib/cluster/leader');
const { keyFingerprint, liveReplicas, replicaHeartbeat } = await import(
  '../../../src/lib/cluster/replicas'
);
const { cluster } = await import('../../../src/lib/cluster/state');
const { ADVISORY_NAMESPACE, acquireStartupLock } = await import('../../../src/lib/db/startup-lock');
const { postgresClient } = await import('../../../src/lib/db/connection');

const onPostgres = postgresClient !== null;
const LEADER_LOCK = 2;
const STARTUP_LOCK = 1;

/** A session that is not this "replica", as a second controller would hold. */
function otherReplica(): SQL {
  return new SQL({ url: process.env.TEST_POSTGRES_URL ?? '', max: 1 });
}

async function tryLock(sql: SQL, lock: number): Promise<boolean> {
  const [row] = await sql`select pg_try_advisory_lock(${ADVISORY_NAMESPACE}, ${lock}) as held`;
  return row.held === true;
}

async function eventually(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await Bun.sleep(20);
  }
}

beforeEach(async () => {
  ctx.db = await createTestDb();
});

describe('spent nonces', () => {
  const now = 1_800_000_000_000;

  it('claims a value once while it could still verify', async () => {
    expect(await claimNonce('n', now + 1000, now)).toBe(true);
    expect(await claimNonce('n', now + 1000, now)).toBe(false);
    expect(await isNonceSpent('n', now)).toBe(true);
  });

  it('claims it again once the record has expired', async () => {
    expect(await claimNonce('n', now + 1000, now)).toBe(true);
    expect(await isNonceSpent('n', now + 1000)).toBe(false);
    expect(await claimNonce('n', now + 5000, now + 2000)).toBe(true);
    expect(await claimNonce('n', now + 5000, now + 2000)).toBe(false);
  });

  it('lets exactly one of two simultaneous claims through', async () => {
    const claims = await Promise.all([
      claimNonce('n', now + 1000, now),
      claimNonce('n', now + 1000, now),
    ]);
    expect(claims.sort()).toEqual([false, true]);
  });

  it('prunes only what has expired', async () => {
    await claimNonce('old', now + 10, now);
    await claimNonce('live', now + 1000, now);
    await pruneSpentNonces(now + 100);
    const keys = (await ctx.db.select().from(schema.spentNonces)).map((row) => row.key);
    expect(keys).toEqual(['live']);
  });
});

describe('announcements', () => {
  afterEach(() => {
    cluster.started = false;
    cluster.handlers.clear();
    cluster.generations.clear();
  });

  it("drops this process's copy at once, before the cluster has started", () => {
    let dropped = 0;
    onAnnouncement('test-cache', () => dropped++);
    announce('test-cache');
    expect(dropped).toBe(1);
  });

  it.skipIf(!onPostgres)('bumps the generation and notifies the other replicas', async () => {
    const other = otherReplica();
    const heard: string[] = [];
    const subscription = await other.listen('cpm_cluster', (payload) => heard.push(payload));
    try {
      cluster.started = true;
      announce('test-cache');
      await eventually(() => heard.length > 0);
      expect(JSON.parse(heard[0])).toEqual({
        from: cluster.replicaId,
        name: 'test-cache',
        generation: 1,
      });
      const [row] = await ctx.db.select().from(schema.clusterGenerations);
      expect(row).toEqual({ name: 'test-cache', generation: 1 });
    } finally {
      await subscription.unlisten();
      await other.close();
    }
  });

  it('catches up on a generation bumped while it was not listening, once', async () => {
    let dropped = 0;
    onAnnouncement('test-cache', () => dropped++);
    await ctx.db.insert(schema.clusterGenerations).values({ name: 'test-cache', generation: 5 });
    await catchUpOnAnnouncements();
    await catchUpOnAnnouncements();
    expect(dropped).toBe(1);
  });
});

describe.skipIf(!onPostgres)('listening to the other replicas', () => {
  it('lets go of its subscriptions when stopped', async () => {
    const other = otherReplica();
    const heard: unknown[] = [];
    onClusterMessage('test-ping', (data) => heard.push(data));
    const send = (n: number) =>
      other.notify('cpm_bus', JSON.stringify({ from: 'other', type: 'test-ping', data: n }));
    try {
      await listenForMessages(postgresClient!);
      expect(cluster.subscriptions).toHaveLength(1);
      await send(1);
      await eventually(() => heard.length === 1);

      await stopListening();
      expect(cluster.subscriptions).toEqual([]);
      await send(2);
      await Bun.sleep(200);
      expect(heard).toEqual([1]);
    } finally {
      cluster.messageHandlers.delete('test-ping');
      await stopListening();
      await other.close();
    }
  });
});

describe.skipIf(!onPostgres)('the startup lock', () => {
  it('keeps a second replica out until released', async () => {
    const other = otherReplica();
    try {
      const release = await acquireStartupLock();
      expect(await tryLock(other, STARTUP_LOCK)).toBe(false);
      await release();
      expect(await tryLock(other, STARTUP_LOCK)).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('is reentrant within the process, so a pass importing the db module cannot deadlock', async () => {
    const release = await acquireStartupLock();
    const inner = await acquireStartupLock();
    await inner();
    await release();
  });
});

describe.skipIf(!onPostgres)('leadership', () => {
  let started = 0;
  let stopped = 0;

  beforeEach(() => {
    started = 0;
    stopped = 0;
    runAsLeader({ name: 'test job', start: () => started++, stop: () => stopped++ });
  });

  afterEach(async () => {
    await resignLeadership();
    cluster.jobs.length = 0;
  });

  it('runs the jobs only while it holds the lock', async () => {
    const other = otherReplica();
    try {
      await contendForLeadership();
      expect(isLeader()).toBe(true);
      expect(started).toBe(1);
      expect(await tryLock(other, LEADER_LOCK)).toBe(false);

      await resignLeadership();
      expect(stopped).toBe(1);
      expect(await tryLock(other, LEADER_LOCK)).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('waits while another replica leads, and takes over once it is gone', async () => {
    const other = otherReplica();
    try {
      expect(await tryLock(other, LEADER_LOCK)).toBe(true);
      await contendForLeadership();
      expect(isLeader()).toBe(false);
      expect(started).toBe(0);
    } finally {
      // Closing frees the lock, as a crashed leader's connection would.
      await other.close();
    }
    await contendForLeadership();
    expect(isLeader()).toBe(true);
    expect(started).toBe(1);
  });

  it('stops the jobs once the connection holding the lock is gone', async () => {
    await contendForLeadership();
    expect(isLeader()).toBe(true);

    const other = otherReplica();
    try {
      await other`select pg_terminate_backend(pid) from pg_locks
        where locktype = 'advisory' and classid = ${ADVISORY_NAMESPACE} and objid = ${LEADER_LOCK}`;
    } finally {
      await other.close();
    }
    await contendForLeadership();
    expect(isLeader()).toBe(false);
    expect(stopped).toBe(1);
  });

  it('starts a job registered after it took the lead straight away', async () => {
    await contendForLeadership();
    let late = 0;
    runAsLeader({ name: 'late job', start: () => late++, stop: () => {} });
    expect(late).toBe(1);
  });
});

describe.skipIf(!onPostgres)('replicas', () => {
  const now = 1_800_000_000_000;

  it('registers this replica and keeps it live by heartbeat', async () => {
    await registerReplica(now);
    expect((await liveReplicas(now)).map((replica) => replica.id)).toEqual([cluster.replicaId]);
    expect(await liveReplicas(now + 60_000)).toEqual([]);
    await replicaHeartbeat(now + 60_000);
    expect(await liveReplicas(now + 60_000)).toHaveLength(1);
  });

  it('refuses to join a live replica that holds another SESSION_SECRET', async () => {
    await ctx.db.insert(schema.controllerReplicas).values({
      id: 'other',
      hostname: 'elsewhere',
      keyFingerprint: '0000000000000000',
      startedAt: now,
      heartbeatAt: now,
    });
    await expect(registerReplica(now)).rejects.toBeInstanceOf(ReplicaKeyMismatchError);
  });

  it('joins a live replica with the same key, and ignores a stale one with another', async () => {
    await ctx.db.insert(schema.controllerReplicas).values([
      {
        id: 'peer',
        hostname: 'a',
        keyFingerprint: keyFingerprint(),
        startedAt: now,
        heartbeatAt: now,
      },
      {
        id: 'gone',
        hostname: 'b',
        keyFingerprint: '0000000000000000',
        startedAt: 0,
        heartbeatAt: 0,
      },
    ]);
    await registerReplica(now);
    expect((await liveReplicas(now)).map((replica) => replica.id).sort()).toEqual(
      [cluster.replicaId, 'peer'].sort(),
    );
  });

  it('comes back after being pruned while it stalled, and forgets replicas long gone', async () => {
    await ctx.db.insert(schema.controllerReplicas).values({
      id: 'gone',
      hostname: 'b',
      keyFingerprint: keyFingerprint(),
      startedAt: 0,
      heartbeatAt: 0,
    });
    await replicaHeartbeat(now);
    const ids = (await ctx.db.select().from(schema.controllerReplicas)).map((row) => row.id);
    expect(ids).toEqual([cluster.replicaId]);
  });
});
