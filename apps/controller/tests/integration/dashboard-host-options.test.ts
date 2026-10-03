/**
 * The dashboard host's proxy options, from the host form and copied from a stored host.
 * Integration because the proxy host model's merge and lookups all read the database.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { setCaddyAdminTransport } from '../../src/lib/caddy-admin';
import {
  dashboardHostFormView,
  dashboardSettingsFromHost,
  listDomainClaims,
  readDashboardHostOptions,
} from '../../src/lib/dashboard-host-options';
import type { DashboardHostOptions } from '../../src/lib/dashboard-host';
import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { setHostAgents } from '../../src/lib/models/host-agents';
import { startFakeAgent } from '../helpers/fake-agent';
import * as schema from '../../src/lib/db/schema';

type FakeAgent = Awaited<ReturnType<typeof startFakeAgent>>;
let agent: FakeAgent;
let agentRowId: number;

beforeEach(async () => {
  agent = await startFakeAgent();
  setCaddyAdminTransport(async () => ({ status: 200, text: '{}', headers: {} }));
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.agents);
  await ctx.db.delete(schema.users).catch(() => {});
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await ctx.db
    .insert(schema.agents)
    .values({
      name: 'edge',
      agentId: 'edge-agent',
      secret: 'unused',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  agentRowId = row!.id;
});

afterEach(async () => {
  await agent.stop();
});

const redirects = [{ from: '/old', to: '/new', status: 301 as const }];

async function createDashboardLikeHost(domains: string[]) {
  const host = await createProxyHost(
    {
      name: 'old dashboard',
      domains,
      upstreams: ['cpm-old:3000'],
      sslForced: true,
      hstsSubdomains: true,
      redirects,
      cpmForwardAuth: { enabled: true },
      anubis: { enabled: true, upstream: 'http://anubis:8923' },
    } as never,
    1,
  );
  await setHostAgents('http', host.id, [agentRowId]);
  return host;
}

describe('copying a stored host into the dashboard host', () => {
  it('carries over its options, HTTPS and agents on the dashboard domain', async () => {
    const host = await createDashboardLikeHost(['CPM.example.com', 'other.example.com']);

    const copied = await dashboardSettingsFromHost(host.id, 'cpm.example.com');

    expect(copied?.host.id).toBe(host.id);
    expect(copied?.settings.enabled).toBe(true);
    expect(copied?.settings.domain).toBe('cpm.example.com');
    // Forced HTTPS has pinned browsers; the copy must not fall back to HTTP.
    expect(copied?.settings.tls).toBe(true);
    const options = copied?.settings.options as DashboardHostOptions;
    expect(options.hstsSubdomains).toBe(true);
    expect(options.agentIds).toEqual([agentRowId]);

    const view = dashboardHostFormView(options);
    expect(view.redirects).toEqual(redirects);
    // Its grants are keyed by a host id the managed host does not have.
    expect(view.cpmForwardAuth).toBeNull();
    // Agents and API clients reach the dashboard; none of them can solve a challenge.
    expect(view.anubis).toBeNull();
  });

  it('refuses a host that does not claim the domain', async () => {
    const host = await createDashboardLikeHost(['app.example.com']);

    expect(await dashboardSettingsFromHost(host.id, 'cpm.example.com')).toBeNull();
    expect(await dashboardSettingsFromHost(host.id + 1000, 'app.example.com')).toBeNull();
  });

  it('lists each host by its lower-cased domains', async () => {
    const host = await createDashboardLikeHost(['CPM.example.com']);

    expect(await listDomainClaims()).toEqual([
      { id: host.id, name: 'old dashboard', domains: ['cpm.example.com'], enabled: true },
    ]);
  });
});

describe('reading the dashboard host options from the form', () => {
  // The agent row is created per test, after this is declared.
  const stored = (): DashboardHostOptions => ({
    certificateId: null,
    accessListId: null,
    hstsSubdomains: true,
    skipHttpsHostnameValidation: false,
    agentIds: [agentRowId],
    meta: JSON.stringify({ redirects }),
  });

  it('keeps what is stored when the form carries no options', async () => {
    const form = new FormData();
    form.set('enabled', 'on');
    const existing = stored();

    expect(await readDashboardHostOptions(form, existing, 'cpm.example.com')).toBe(existing);
  });

  it('merges the sections the form rendered and leaves the rest', async () => {
    const form = new FormData();
    form.set('dashboardOptionsPresent', '1');
    form.set('certificateId', '__none__');
    form.set('accessListId', '__none__');
    form.set('pathBlocksJson', JSON.stringify([{ path: '/private/*', status: 403 }]));
    form.set('cpmForwardAuthPresent', '1');
    form.set('cpmForwardAuthEnabledPresent', '1');
    form.set('cpmForwardAuthEnabled', 'on');
    form.set('anubisPresent', '1');
    form.set('anubisEnabled', 'on');
    form.set('anubisUpstream', 'http://anubis:8923');
    const existing = stored();

    const options = await readDashboardHostOptions(form, existing, 'cpm.example.com');
    const view = dashboardHostFormView(options);

    expect(view.pathBlocks.map((rule) => rule.path)).toEqual(['/private/*']);
    expect(view.redirects).toEqual(redirects);
    expect(options.hstsSubdomains).toBe(true);
    expect(options.agentIds).toEqual(existing.agentIds);
    expect(view.cpmForwardAuth).toBeNull();
    expect(view.anubis).toBeNull();
  });

  it('clears the agent pinning when the field is sent empty', async () => {
    const form = new FormData();
    form.set('dashboardOptionsPresent', '1');
    form.set('agentAssignmentPresent', '1');

    const options = await readDashboardHostOptions(form, stored(), 'cpm.example.com');

    expect(options.agentIds).toEqual([]);
  });

  it('drops a certificate that no longer exists', async () => {
    const form = new FormData();
    form.set('dashboardOptionsPresent', '1');
    form.set('certificateId', '9999');

    const options = await readDashboardHostOptions(form, stored(), 'cpm.example.com');

    expect(options.certificateId).toBeNull();
  });
});
