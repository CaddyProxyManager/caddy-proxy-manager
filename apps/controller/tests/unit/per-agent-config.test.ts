/**
 * **No assignment means every agent** - backwards, it takes every existing site down at once - so
 * it is pinned from both directions.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import {
  agentIdsForHost,
  listHostAssignments,
  parseAgentIds,
  servedByAgent,
  setHostAgents,
} from '../../src/lib/models/host-agents';
import { getAgentBuildSettings, setAgentBuildSettings } from '../../src/lib/models/agents';
import { resolveBuildSettingsFor } from '../../src/lib/caddy-build';
import { getRequiredL4Ports } from '../../src/lib/l4-ports';
import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { createL4ProxyHost } from '../../src/lib/models/l4-proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';

const AGENT_A = 1;
const AGENT_B = 2;

async function seedAgents() {
  const now = new Date().toISOString();
  await ctx.db.insert(schema.agents).values([
    {
      id: AGENT_A,
      name: 'edge-a',
      agentId: 'a'.repeat(32),
      secret: 'x',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: AGENT_B,
      name: 'edge-b',
      agentId: 'b'.repeat(32),
      secret: 'x',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHostAgents);
  await ctx.db.delete(schema.l4ProxyHostAgents);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.agents);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await seedAgents();
});

describe('the unassigned rule', () => {
  it('treats a host with no assignments as served by every agent', () => {
    const assignments = new Map<number, number[]>();
    expect(servedByAgent(assignments, 7, AGENT_A)).toBe(true);
    expect(servedByAgent(assignments, 7, AGENT_B)).toBe(true);
  });

  it('treats an empty assignment list the same as none at all', () => {
    // Reading an empty bucket as "nowhere" would take the host offline.
    expect(servedByAgent(new Map([[7, []]]), 7, AGENT_A)).toBe(true);
  });

  it('excludes an agent the host is not assigned to', () => {
    const assignments = new Map([[7, [AGENT_A]]]);
    expect(servedByAgent(assignments, 7, AGENT_A)).toBe(true);
    expect(servedByAgent(assignments, 7, AGENT_B)).toBe(false);
  });

  it('includes everything when there is no agent in hand at all', () => {
    // The fleet-wide document must not filter because a host was pinned somewhere.
    expect(servedByAgent(new Map([[7, [AGENT_A]]]), 7, null)).toBe(true);
  });
});

describe('setHostAgents', () => {
  it('replaces the set, adding and removing only what changed', async () => {
    const host = await createProxyHost(
      { name: 'h', domains: ['h.example.com'], upstreams: ['a:80'] } as never,
      1,
    );

    await setHostAgents('http', host.id, [AGENT_A, AGENT_B]);
    expect(await agentIdsForHost('http', host.id)).toEqual([AGENT_A, AGENT_B]);

    await setHostAgents('http', host.id, [AGENT_B]);
    expect(await agentIdsForHost('http', host.id)).toEqual([AGENT_B]);

    await setHostAgents('http', host.id, []);
    expect(await agentIdsForHost('http', host.id)).toEqual([]);
  });

  it('ignores a repeated agent rather than failing on the unique index', async () => {
    const host = await createProxyHost(
      { name: 'h', domains: ['h.example.com'], upstreams: ['a:80'] } as never,
      1,
    );
    await setHostAgents('http', host.id, [AGENT_A, AGENT_A]);
    expect(await agentIdsForHost('http', host.id)).toEqual([AGENT_A]);
  });

  it('is applied by createProxyHost from its input', async () => {
    const host = await createProxyHost(
      {
        name: 'h',
        domains: ['h.example.com'],
        upstreams: ['a:80'],
        agentIds: [AGENT_B],
      } as never,
      1,
    );
    expect(await agentIdsForHost('http', host.id)).toEqual([AGENT_B]);
    expect([...(await listHostAssignments('http')).keys()]).toEqual([host.id]);
  });
});

describe('parseAgentIds', () => {
  it('accepts the repeated form a checkbox list submits', () => {
    expect(parseAgentIds(['2', '1', '2'])).toEqual([1, 2]);
  });

  it('drops anything that is not a positive integer', () => {
    expect(parseAgentIds(['0', '-1', 'nine', ''])).toEqual([]);
  });

  it('reads an absent field as the empty list, which means every agent', () => {
    expect(parseAgentIds(undefined)).toEqual([]);
  });
});

describe('buildCaddyDocument scoped to an agent', () => {
  function hostNames(doc: unknown): string[] {
    const found: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj.host)) found.push(...obj.host.map(String));
      Object.values(obj).forEach(walk);
    };
    walk(doc);
    return found;
  }

  it('serves an unassigned host on every agent and a pinned one on only its own', async () => {
    await createProxyHost(
      { name: 'shared', domains: ['shared.example.com'], upstreams: ['a:80'] } as never,
      1,
    );
    await createProxyHost(
      {
        name: 'pinned',
        domains: ['pinned.example.com'],
        upstreams: ['a:80'],
        agentIds: [AGENT_A],
      } as never,
      1,
    );

    const onA = hostNames(JSON.parse(JSON.stringify(await buildCaddyDocument(AGENT_A))));
    const onB = hostNames(JSON.parse(JSON.stringify(await buildCaddyDocument(AGENT_B))));

    expect(onA).toContain('shared.example.com');
    expect(onA).toContain('pinned.example.com');
    expect(onB).toContain('shared.example.com');
    expect(onB).not.toContain('pinned.example.com');
  });

  it('filters nothing when no agent is named', async () => {
    await createProxyHost(
      {
        name: 'pinned',
        domains: ['pinned.example.com'],
        upstreams: ['a:80'],
        agentIds: [AGENT_A],
      } as never,
      1,
    );
    const fleet = hostNames(JSON.parse(JSON.stringify(await buildCaddyDocument())));
    expect(fleet).toContain('pinned.example.com');
  });
});

describe('required L4 ports scoped to an agent', () => {
  it('leaves out the port of a host pinned to another agent', async () => {
    await createL4ProxyHost(
      {
        name: 'db-a',
        protocol: 'tcp',
        listenAddress: ':5432',
        upstreams: ['a:5432'],
        agentIds: [AGENT_A],
      } as never,
      1,
    );
    await createL4ProxyHost(
      { name: 'shared', protocol: 'tcp', listenAddress: ':9000', upstreams: ['a:9000'] } as never,
      1,
    );

    expect(await getRequiredL4Ports(AGENT_A)).toEqual(['5432:5432', '9000:9000']);
    // Otherwise a container is recreated to publish a port it never answers on.
    expect(await getRequiredL4Ports(AGENT_B)).toEqual(['9000:9000']);
    expect(await getRequiredL4Ports()).toEqual(['5432:5432', '9000:9000']);
  });
});

describe('per-agent build settings', () => {
  it('starts null, so a fresh agent follows the fleet default', async () => {
    expect(await getAgentBuildSettings(AGENT_A)).toBeNull();
    expect(await resolveBuildSettingsFor(AGENT_A)).toBeNull();
  });

  it('overrides the fleet default once one is stored, for that agent alone', async () => {
    await setAgentBuildSettings(AGENT_A, { modules: { 'caddy-l4': false }, customModules: [] });

    expect((await resolveBuildSettingsFor(AGENT_A))?.modules).toEqual({ 'caddy-l4': false });
    expect(await resolveBuildSettingsFor(AGENT_B)).toBeNull();
  });

  it('goes back to following the fleet when the selection is cleared', async () => {
    // Cleared, not copied: a copy would freeze the agent on that day's fleet settings.
    await setAgentBuildSettings(AGENT_A, { modules: { 'caddy-l4': false }, customModules: [] });
    await setAgentBuildSettings(AGENT_A, null);
    expect(await getAgentBuildSettings(AGENT_A)).toBeNull();
  });
});
