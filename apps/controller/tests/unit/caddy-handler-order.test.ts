/**
 * The order of the shared per-host chain. Cheap refusals go first, so a request turned away by
 * a gate never costs a Coraza transaction.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';
import { chainLabels } from '../helpers/host-chains';

const NOW = new Date().toISOString();
const UPSTREAM = '10.0.0.5:8080';

const GEOBLOCK = {
  enabled: true,
  block_countries: ['RU'],
  block_continents: [],
  block_asns: [],
  block_cidrs: [],
  block_ips: [],
  allow_countries: [],
  allow_continents: [],
  allow_asns: [],
  allow_cidrs: [],
  allow_ips: [],
  trusted_proxies: [],
  fail_closed: false,
  response_status: 403,
  response_body: 'Forbidden',
  response_headers: {},
  redirect_url: '',
};

const WAF = { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' };

async function labelsFor(domain: string, options: Record<string, unknown>) {
  await createProxyHost({ name: domain, domains: [domain], upstreams: [UPSTREAM], ...options }, 1);
  const labels = chainLabels(await buildCaddyDocument(), UPSTREAM);
  expect(labels.length).toBeGreaterThan(0);
  return labels;
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
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

describe('handler order', () => {
  it('runs ws-refuse, then geo blocking, then the WAF', async () => {
    for (const labels of await labelsFor('order.example.com', {
      allowWebsocket: false,
      geoblock: GEOBLOCK,
      geoblockMode: 'override',
      waf: WAF,
    })) {
      const ws = labels.indexOf('ws-refuse');
      expect(ws).toBeGreaterThanOrEqual(0);
      expect(labels.indexOf('blocker')).toBeGreaterThan(ws);
      expect(labels.indexOf('waf')).toBeGreaterThan(labels.indexOf('blocker'));
    }
  });

  it('keeps geo blocking ahead of the WAF on a forward-auth host', async () => {
    for (const labels of await labelsFor('order-fa.example.com', {
      geoblock: GEOBLOCK,
      geoblockMode: 'override',
      waf: WAF,
      forwardAuth: { enabled: true, provider: 'authelia', authUpstream: 'http://authelia:9091' },
    })) {
      expect(labels.indexOf('blocker')).toBeGreaterThanOrEqual(0);
      expect(labels.indexOf('waf')).toBeGreaterThan(labels.indexOf('blocker'));
    }
  });
});
