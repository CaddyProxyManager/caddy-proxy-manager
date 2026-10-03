/**
 * The events behind the admin notifications, each from its real source where one can run here: the
 * agent registry, the status an agent reports, a Caddy apply, and the background jobs.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import type { AgentStatus } from '@cpm/shared';
import { agents, settings, users } from '../../src/lib/db/schema';
import { attach, detach, resetRegistry } from '../../src/lib/agent/registry';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../src/lib/email/transport';
import { createUser } from '../../src/lib/models/user';
import {
  flushNotifications,
  getNotificationStatus,
  resetNotificationsForTests,
} from '../../src/lib/notifications';
import {
  reportAgentStatus,
  resetAgentWatchForTests,
  watchAgents,
} from '../../src/lib/notifications/agents';
import {
  GEOIP_FAILURE_STREAK,
  reportCrsPluginDisabled,
  reportGeoipRun,
  reportReleaseAvailable,
} from '../../src/lib/notifications/jobs';
import { BATCH_MS } from '../../src/lib/notifications/plan';
import { invalidateSettingsCache } from '../../src/lib/settings/resolve';
import { installFakeCaddy } from '../helpers/caddy-admin';

const MINUTE = 60_000;
let sent: OutgoingEmail[] = [];
let clock = Date.now();

/** Moves past the batch window and sends what is due. */
async function flush(): Promise<OutgoingEmail[]> {
  // Past anything queued at the real time, which the apply and job hooks use.
  clock = Math.max(clock, Date.now()) + BATCH_MS;
  const before = sent.length;
  await flushNotifications(clock);
  return sent.slice(before);
}

function connect(agentId: string, name: string, rowId: number) {
  attach({
    agentId,
    agentRowId: rowId,
    name,
    controllerId: 'test-controller',
    controllerName: 'Test',
    initialState: {
      l4Ports: [],
      caddyModules: [],
      services: { services: { clickhouse: false }, env: {} },
      fleetConfig: { clickhouse: null, analytics: false, geoip: null },
      caddyEnabled: true,
    },
  });
}

async function pairAgent(agentId: string, name: string, lastSeenAt: string | null) {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(agents)
    .values({ name, agentId, secret: 'x', lastSeenAt, createdAt: now, updatedAt: now })
    .returning();
  return row.id;
}

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agentId: 'a1',
    version: 'test',
    mode: 'standalone',
    composeProject: 'cpm',
    l4Ports: { applied: [], status: { state: 'idle' } },
    caddyBuild: { applied: null, status: { state: 'idle' } },
    services: { applied: null, status: { state: 'idle' } },
    analytics: { enabled: false, accessLogPresent: false },
    ...overrides,
  };
}

beforeEach(async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
  sent = [];
  clock = Date.now();
  setEmailDeliveryForTests(async (_config, message) => {
    sent.push(message);
  });
  resetRegistry();
  resetAgentWatchForTests();
  await ctx.db.delete(agents);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
  await resetNotificationsForTests();
  await createUser({
    email: 'ops@example.com',
    role: 'admin',
    provider: 'credentials',
    subject: 'a',
  });
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  resetRegistry();
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  invalidateSettingsCache();
});

describe('agent offline', () => {
  it('tells once an agent has been gone past the threshold, and once it is back', async () => {
    const rowId = await pairAgent('agent-1', 'edge-1', new Date().toISOString());
    connect('agent-1', 'edge-1', rowId);
    await watchAgents(clock);
    expect(await flush()).toEqual([]);

    detach('agent-1');
    const gone = clock;
    await watchAgents(gone);
    await watchAgents(gone + 4 * MINUTE);
    expect((await getNotificationStatus()).pending).toBe(0);
    await watchAgents(gone + 5 * MINUTE);
    clock = gone + 5 * MINUTE;
    const alert = await flush();
    expect(alert.map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: Agent edge-1 is offline',
    ]);
    expect(alert[0].text).toContain('has been disconnected for more than 5 minutes');

    await watchAgents(clock + MINUTE);
    expect(await flush()).toEqual([]);

    connect('agent-1', 'edge-1', rowId);
    await watchAgents(clock);
    expect((await flush()).map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: Agent edge-1 is back online',
    ]);
  });

  it('follows the threshold setting, and says nothing of a blip shorter than a batch', async () => {
    process.env.NOTIFY_AGENT_OFFLINE_MINUTES = '1';
    invalidateSettingsCache();
    try {
      const rowId = await pairAgent('agent-2', 'edge-2', new Date().toISOString());
      await watchAgents(clock);
      await watchAgents(clock + MINUTE);
      // Back before the alert's batch went out: neither email.
      connect('agent-2', 'edge-2', rowId);
      await watchAgents(clock + MINUTE + 1_000);
      expect(await flush()).toEqual([]);
    } finally {
      delete process.env.NOTIFY_AGENT_OFFLINE_MINUTES;
      invalidateSettingsCache();
    }
  });

  it('never tells about an agent that never connected, and forgets one unpaired', async () => {
    await pairAgent('agent-3', 'never', null);
    await pairAgent('agent-4', 'gone', new Date().toISOString());
    await watchAgents(clock);
    await watchAgents(clock + 10 * MINUTE);
    clock += 10 * MINUTE;
    const alert = await flush();
    expect(alert.map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: Agent gone is offline',
    ]);

    await ctx.db.delete(agents);
    await watchAgents(clock);
    expect(await flush()).toEqual([]);
  });
});

describe('agent-reported failures', () => {
  const agent = { agentId: 'a1', name: 'edge-1' };

  it('raises a failed operation once, with its message, and tells when it applies', async () => {
    const failed = status({
      caddyBuild: { applied: null, status: { state: 'failed', error: 'go: module not found' } },
    });
    await reportAgentStatus(agent, null, failed, clock);
    await reportAgentStatus(agent, failed, failed, clock);
    const alert = await flush();
    expect(alert.map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: Caddy build failed on edge-1',
    ]);
    expect(alert[0].text).toContain(
      'The Caddy image build failed on edge-1 (go: module not found)',
    );

    const applied = status({ caddyBuild: { applied: [], status: { state: 'applied' } } });
    await reportAgentStatus(agent, failed, applied, clock);
    expect((await flush())[0].subject).toBe(
      'Caddy Proxy Manager: Caddy build works again on edge-1',
    );
  });

  it('reads log files it cannot prune, services and L4 ports', async () => {
    const report = status({
      services: { applied: null, status: { state: 'failed', message: 'compose up failed' } },
      l4Ports: { applied: [], status: { state: 'failed' } },
      logAccess: {
        caddyContainer: 'caddy',
        agentGroups: [],
        caddyGid: 1000,
        problems: [{ kind: 'cleanupBlocked', path: '/logs', uid: 0, gid: 0, mode: 0o755 }],
      },
    });
    await reportAgentStatus(agent, null, report, clock);
    const [message] = await flush();
    expect(message.subject).toBe('Caddy Proxy Manager: 3 notifications');
    expect(message.text).toContain('Starting or stopping ClickHouse or CrowdSec failed on edge-1');
    expect(message.text).toContain('Changing the L4 ports failed on edge-1');
    expect(message.text).toContain('cannot be read or pruned, so its disk may fill (/logs)');
  });
});

describe('Caddy apply', () => {
  it('tells about a refused configuration once, and when one loads again', async () => {
    const caddy = installFakeCaddy();
    caddy.failWith(400, 'bad config');
    await expect(applyCaddyConfig()).rejects.toThrow();
    await expect(applyCaddyConfig()).rejects.toThrow();
    const alert = await flush();
    expect(alert.map((message) => message.subject)).toEqual([
      'Caddy Proxy Manager: Caddy refused its configuration',
    ]);
    expect(alert[0].text).toContain('Caddy did not load its configuration: Caddy rejected');

    caddy.reset();
    await applyCaddyConfig();
    expect((await flush())[0].subject).toBe(
      'Caddy Proxy Manager: Caddy loads its configuration again',
    );
  });

  it('leaves an unreachable Caddy to the agent watch', async () => {
    const caddy = installFakeCaddy();
    caddy.failWithNetworkError('ECONNREFUSED');
    await expect(applyCaddyConfig()).rejects.toThrow();
    expect(await flush()).toEqual([]);
  });
});

describe('background jobs', () => {
  it('tells about GeoIP once it keeps failing, and when it works again', async () => {
    for (let i = 1; i < GEOIP_FAILURE_STREAK; i++) {
      await reportGeoipRun({ error: 'HTTP 401' }, clock);
    }
    await reportGeoipRun({ error: null, skipped: 'disabled' }, clock);
    expect(await flush()).toEqual([]);
    await reportGeoipRun({ error: 'HTTP 401' }, clock);
    const alert = await flush();
    expect(alert[0].text).toContain('failed 3 times in a row: HTTP 401');
    await reportGeoipRun({ error: null }, clock);
    expect((await flush())[0].subject).toBe('Caddy Proxy Manager: GeoIP update works again');
  });

  it('tells about a CRS plugin switched off, and a release once', async () => {
    await reportCrsPluginDisabled({ id: 4, name: 'wordpress', version: 'v1.1.0' });
    await reportCrsPluginDisabled({ id: 4, name: 'wordpress', version: 'v1.1.0' });
    await reportReleaseAvailable('4.0.0', '3.9.0');
    await reportReleaseAvailable('4.0.0', '3.9.0');
    const [message] = await flush();
    expect(message.subject).toBe('Caddy Proxy Manager: 2 notifications');
    expect(message.text).toContain('the CRS plugin wordpress v1.1.0, so it was switched off');
    expect(message.text).toContain('Release 4.0.0 is available. This instance runs 3.9.0.');
  });
});
