/** Maintenance mode: first in the chain for every route shape, the bypass, the page and the toggle. */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { auditEvents } from '@/tests/helpers/audit-events';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const audit = vi.hoisted(() => ({ logAuditEvent: vi.fn() }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => audit);

import {
  createProxyHost,
  getProxyHost,
  setProxyHostMaintenance,
  updateProxyHost,
} from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import { saveErrorPagesSettings } from '../../../src/lib/settings';
import {
  BUILT_IN_MAINTENANCE_PAGE,
  buildMaintenanceHandler,
  resolveMaintenancePage,
} from '../../../src/lib/proxy-hosts/maintenance';
import { parseProxyHostOptionUpdates } from '../../../src/lib/proxy-hosts/form';
import { matchAuditSummary } from '../../../src/lib/audit/summary';
import * as schema from '../../../src/lib/db/schema';
import { chainLabels, chainsTo, type Handler } from '../../helpers/host-chains';

const NOW = new Date().toISOString();
const UPSTREAM = '10.0.0.5:8080';
const ON = { enabled: true, retryAfter: 600, bypassCidrs: ['203.0.113.7', '10.0.0.0/8'] };

async function build(domain: string, options: Record<string, unknown>) {
  await createProxyHost({ name: domain, domains: [domain], upstreams: [UPSTREAM], ...options }, 1);
  return buildCaddyDocument();
}

/** The one maintenance subroute in each chain to the upstream. */
function maintenanceHandlers(doc: unknown): Handler[] {
  return chainsTo(doc, UPSTREAM).map((chain) => {
    const found = chain.filter((h) => JSON.stringify(h).includes('"status_code":503'));
    expect(found).toHaveLength(1);
    return found[0] as Handler;
  });
}

function staticResponse(handler: Handler): Record<string, unknown> {
  const routes = handler.routes as { handle: Record<string, unknown>[] }[];
  return routes[0]!.handle[0]!;
}

beforeEach(async () => {
  audit.logAuditEvent.mockClear();
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('placement', () => {
  const shapes: [string, Record<string, unknown>][] = [
    [
      'plain, with a location rule and ws-refuse',
      { allowWebsocket: false, locationRules: [{ path: '/api/*', upstreams: [UPSTREAM] }] },
    ],
    [
      'generic forward auth',
      {
        forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'http://authelia:9091' },
      },
    ],
    [
      'Authentik, protected paths only',
      {
        authentik: {
          enabled: true,
          outpostDomain: 'outpost.goauthentik.io',
          outpostUpstream: 'http://authentik-server:9000',
          protectedPaths: ['/admin/*'],
        },
      },
    ],
    ['the WAF', { waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' } }],
  ];

  for (const [name, options] of shapes) {
    it(`comes before everything but ws-refuse: ${name}`, async () => {
      const doc = await build('shape.example.com', { ...options, maintenance: ON });
      const chains = chainLabels(doc, UPSTREAM);
      expect(chains.length).toBeGreaterThan(0);
      for (const labels of chains) {
        const at = labels.indexOf('maintenance');
        const before = labels.slice(0, at).filter((l) => l !== 'headers');
        expect(at).toBeGreaterThanOrEqual(0);
        // A forward-auth host's identity-header strip is the only thing allowed ahead of it.
        expect(before.every((l) => l === 'ws-refuse')).toBe(true);
        expect(at).toBeLessThan(labels.indexOf('reverse_proxy'));
        if (labels.includes('waf')) expect(at).toBeLessThan(labels.indexOf('waf'));
        if (labels.includes('encode')) expect(at).toBeLessThan(labels.indexOf('encode'));
      }
    });
  }

  it('is left out while off, and the settings are kept', async () => {
    const host = await createProxyHost(
      {
        name: 'off',
        domains: ['off.example.com'],
        upstreams: [UPSTREAM],
        maintenance: { ...ON, enabled: false },
      },
      1,
    );
    expect(JSON.stringify(await buildCaddyDocument())).not.toContain('"status_code":503');
    expect(host.maintenance).toEqual({
      enabled: false,
      retryAfter: 600,
      bypassCidrs: ['203.0.113.7/32', '10.0.0.0/8'],
      body: null,
    });
  });
});

describe('the response', () => {
  it('lets the bypass ranges through and sends Retry-After', async () => {
    const [handler] = maintenanceHandlers(await build('bypass.example.com', { maintenance: ON }));
    const routes = handler!.routes as { match?: unknown }[];
    expect(routes[0]!.match).toEqual([
      { not: [{ client_ip: { ranges: ['203.0.113.7/32', '10.0.0.0/8'] } }] },
    ]);
    const response = staticResponse(handler!);
    expect(response.status_code).toBe(503);
    expect(response.headers).toMatchObject({
      'Retry-After': ['600'],
      'Cache-Control': ['no-store'],
    });
  });

  it('matches everyone with no bypass, and sends no Retry-After unless asked', () => {
    const handler = buildMaintenanceHandler({ enabled: true }, BUILT_IN_MAINTENANCE_PAGE);
    const routes = handler.routes as { match?: unknown }[];
    expect(routes[0]!.match).toBeUndefined();
    expect(staticResponse(handler).headers).not.toHaveProperty('Retry-After');
  });

  it('escapes the host placeholders in the page, as error pages do', () => {
    const handler = buildMaintenanceHandler(
      { enabled: true },
      { body: 'Back soon {env.SECRET} {http.request.host}', contentType: 'text/plain' },
    );
    expect(staticResponse(handler).body).toBe(
      String.raw`Back soon \{env.SECRET} {http.request.host}`,
    );
  });

  it('picks the host page, then its 503 error page, then the global one, then the built-in', async () => {
    const host503 = [
      { statuses: [404], body: 'not found' },
      { statuses: [502, 503], body: 'host 503', contentType: 'text/plain' },
    ];
    const global503 = [{ statuses: [], body: 'global any' }];
    expect(resolveMaintenancePage({ enabled: true, body: 'own' }, host503, global503).body).toBe(
      'own',
    );
    expect(resolveMaintenancePage({ enabled: true }, host503, global503)).toEqual({
      body: 'host 503',
      contentType: 'text/plain',
    });
    expect(resolveMaintenancePage({ enabled: true }, host503.slice(0, 1), global503).body).toBe(
      'global any',
    );
    expect(resolveMaintenancePage({ enabled: true }, [], [])).toEqual(BUILT_IN_MAINTENANCE_PAGE);

    await saveErrorPagesSettings({ rules: [{ statuses: [503], body: 'global 503' }] });
    const [handler] = maintenanceHandlers(
      await build('global.example.com', { maintenance: { enabled: true } }),
    );
    expect(staticResponse(handler!).body).toBe('global 503');
  });
});

describe('input', () => {
  it('refuses a bypass entry that is not an address or range', async () => {
    await expect(
      createProxyHost(
        {
          name: 'bad',
          domains: ['bad.example.com'],
          upstreams: [UPSTREAM],
          maintenance: { enabled: true, bypassCidrs: ['office'] },
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'hostMaintenanceBypassInvalid' });
  });

  it('reads the editor card, and a form without it leaves the host alone', async () => {
    const form = new FormData();
    form.set('maintenancePresent', '1');
    form.set('maintenanceEnabled', 'on');
    form.set('maintenanceBypass', '192.0.2.1\n 198.51.100.0/24 ');
    form.set('maintenanceRetryAfter', '');
    form.set('maintenanceBody', '<p>Soon</p>\r\n');
    expect(parseProxyHostOptionUpdates(form).maintenance).toEqual({
      enabled: true,
      retryAfter: null,
      bypassCidrs: ['192.0.2.1', '198.51.100.0/24'],
      body: '<p>Soon</p>\n',
    });
    expect(parseProxyHostOptionUpdates(new FormData()).maintenance).toBeUndefined();

    const host = await createProxyHost(
      { name: 'kept', domains: ['kept.example.com'], upstreams: [UPSTREAM], maintenance: ON },
      1,
    );
    await updateProxyHost(host.id, parseProxyHostOptionUpdates(new FormData()), 1);
    expect((await getProxyHost(host.id))?.maintenance?.enabled).toBe(true);
  });
});

describe('quick toggle', () => {
  it('flips only enabled, keeps the rest, and audits the switch', async () => {
    const host = await createProxyHost(
      {
        name: 'toggle',
        domains: ['toggle.example.com'],
        upstreams: [UPSTREAM],
        maintenance: { ...ON, enabled: false, body: 'Back at noon' },
      },
      1,
    );
    const logged = auditEvents(() => ctx.db);
    await logged.clear();

    const on = await setProxyHostMaintenance(host.id, true, 1);
    expect(on.maintenance).toEqual({
      enabled: true,
      retryAfter: 600,
      bypassCidrs: ['203.0.113.7/32', '10.0.0.0/8'],
      body: 'Back at noon',
    });
    const [event] = await logged.list();
    expect(event.summary).toBe('Turned on maintenance mode for proxy host toggle');
    expect(matchAuditSummary({ ...event, summary: event.summary ?? '' })?.message).toBe(
      'proxyHostMaintenanceOn',
    );

    expect((await setProxyHostMaintenance(host.id, false, 1)).maintenance?.enabled).toBe(false);
  });

  it('turns on a host that never had it configured', async () => {
    const host = await createProxyHost(
      { name: 'fresh', domains: ['fresh.example.com'], upstreams: [UPSTREAM] },
      1,
    );
    expect(host.maintenance).toBeNull();
    await setProxyHostMaintenance(host.id, true, 1);
    const [handler] = maintenanceHandlers(await buildCaddyDocument());
    expect(staticResponse(handler!).body).toBe(BUILT_IN_MAINTENANCE_PAGE.body);
  });
});
