/**
 * Whether the dashboard row reaches the document, and that it wins a tie with a stored host on the
 * same exact domain - otherwise that host would shadow the route the operator needs to undo it.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { setCaddyAdminTransport } from '../../../src/lib/caddy/admin';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import { saveDashboardSettings } from '../../../src/lib/settings';
import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { startFakeAgent } from '../../helpers/fake-agent';
import * as schema from '../../../src/lib/db/schema';

type FakeAgent = Awaited<ReturnType<typeof startFakeAgent>>;
let agent: FakeAgent;

type CaddyDocument = {
  apps: { http?: { servers: Record<string, { listen: string[]; routes: unknown[] }> } };
};

/** Host matchers in the order their routes appear, so precedence is observable. */
function hostsInOrder(document: CaddyDocument): string[] {
  const order: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.host)) for (const host of record.host) order.push(host as string);
      Object.values(record).forEach(walk);
    }
  };
  walk(document.apps.http?.servers?.cpm?.routes ?? []);
  return order;
}

function upstreamDials(document: CaddyDocument): string[] {
  const dials: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.dial === 'string') dials.push(record.dial);
      Object.values(record).forEach(walk);
    }
  };
  walk(document.apps.http?.servers?.cpm?.routes ?? []);
  return dials;
}

beforeEach(async () => {
  agent = await startFakeAgent();
  setCaddyAdminTransport(async () => ({ status: 200, text: '{}', headers: {} }));
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  await agent.stop();
});

describe('the dashboard host in the generated config', () => {
  it('is absent while the setting is off', async () => {
    await saveDashboardSettings({ enabled: false, domain: 'cpm.example.com', tls: false });

    const document = (await buildCaddyDocument()) as CaddyDocument;

    expect(hostsInOrder(document)).not.toContain('cpm.example.com');
  });

  it('is absent when nothing has decided yet', async () => {
    // A database with no dashboard blob at all - every install before this feature existed.
    const document = (await buildCaddyDocument()) as CaddyDocument;

    expect(document.apps.http?.servers?.cpm).toBeUndefined();
  });

  it('serves the domain and proxies it to the controller', async () => {
    await saveDashboardSettings({ enabled: true, domain: 'cpm.example.com', tls: false });

    const document = (await buildCaddyDocument()) as CaddyDocument;

    expect(hostsInOrder(document)).toContain('cpm.example.com');
    // getCpmDialAddress resolves to the web service on the compose network under the test
    // environment's CADDY_API_URL; whatever it answers, the route has to dial something.
    expect(upstreamDials(document).length).toBeGreaterThan(0);
  });

  it('wins the tie against a stored host claiming the same domain', async () => {
    await saveDashboardSettings({ enabled: true, domain: 'cpm.example.com', tls: false });
    await createProxyHost(
      { name: 'impostor', domains: ['cpm.example.com'], upstreams: ['backend:8080'] } as never,
      1,
    );

    const dials = upstreamDials((await buildCaddyDocument()) as CaddyDocument);

    // Both routes carry the same host matcher, so the sort leaves them in the order they were
    // built and Caddy takes the first. It must not be the one pointing at backend:8080.
    expect(dials[0]).not.toBe('backend:8080');
    expect(dials).toContain('backend:8080');
  });

  it('applies its proxy options the way a stored host would', async () => {
    await saveDashboardSettings({
      enabled: true,
      domain: 'cpm.example.com',
      tls: false,
      options: {
        certificateId: null,
        accessListId: null,
        hstsSubdomains: false,
        skipHttpsHostnameValidation: false,
        agentIds: [],
        meta: JSON.stringify({ path_blocks: [{ path: '/blocked-by-dashboard/*', status: 403 }] }),
      },
    });

    const document = JSON.stringify(await buildCaddyDocument());

    expect(document).toContain('/blocked-by-dashboard/*');
  });

  it('is served only by the agents it is pinned to', async () => {
    await saveDashboardSettings({
      enabled: true,
      domain: 'cpm.example.com',
      tls: false,
      options: {
        certificateId: null,
        accessListId: null,
        hstsSubdomains: false,
        skipHttpsHostnameValidation: false,
        agentIds: [41],
        meta: null,
      },
    });

    const pinned = (await buildCaddyDocument(41)) as CaddyDocument;
    const other = (await buildCaddyDocument(42)) as CaddyDocument;
    const fleet = (await buildCaddyDocument()) as CaddyDocument;

    expect(hostsInOrder(pinned)).toContain('cpm.example.com');
    expect(hostsInOrder(other)).not.toContain('cpm.example.com');
    // The fleet-wide document is every agent's, so it keeps the host.
    expect(hostsInOrder(fleet)).toContain('cpm.example.com');
  });

  it('leaves stored hosts alone', async () => {
    await saveDashboardSettings({ enabled: true, domain: 'cpm.example.com', tls: false });
    await createProxyHost(
      { name: 'app', domains: ['app.example.com'], upstreams: ['backend:8080'] } as never,
      1,
    );

    const order = hostsInOrder((await buildCaddyDocument()) as CaddyDocument);

    // Distinct exact domains never compete, so their order is the specificity sort's business;
    // what matters is that the managed host displaced nothing.
    expect(order).toContain('app.example.com');
    expect(order).toContain('cpm.example.com');
    expect(upstreamDials((await buildCaddyDocument()) as CaddyDocument)).toContain('backend:8080');
  });
});
