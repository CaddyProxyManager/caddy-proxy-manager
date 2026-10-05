/**
 * The order of the shared per-host chain. Cheap refusals go first, so a request turned away by
 * a gate never costs a Coraza transaction.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import * as schema from '../../../src/lib/db/schema';
import {
  type Handler,
  chainLabels,
  chainsTo,
  handlerLabel,
  withoutMarkers,
} from '../../helpers/host-chains';

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

const WAF = { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' } as const;

async function labelsFor(domain: string, options: Record<string, unknown>) {
  await createProxyHost({ name: domain, domains: [domain], upstreams: [UPSTREAM], ...options }, 1);
  const labels = chainLabels(await buildCaddyDocument(), UPSTREAM);
  expect(labels.length).toBeGreaterThan(0);
  return labels;
}

beforeEach(async () => {
  await ctx.db.delete(schema.blockedSources);
  await ctx.db.delete(schema.wafExclusions);
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

describe('blocked sources', () => {
  async function chainsWithBlocks() {
    await ctx.db.insert(schema.blockedSources).values([
      { kind: 'cidr', value: '198.51.100.0/24', reason: '', expiresAt: null, createdAt: NOW },
      { kind: 'ip', value: '203.0.113.7', reason: '', expiresAt: null, createdAt: NOW },
      { kind: 'country', value: 'CN', reason: '', expiresAt: null, createdAt: NOW },
      // Expired: the build leaves it out before the expiry pass deletes it.
      {
        kind: 'ip',
        value: '192.0.2.1',
        reason: '',
        expiresAt: '2000-01-01T00:00:00.000Z',
        createdAt: NOW,
      },
    ]);
    await createProxyHost(
      {
        name: 'blocks',
        domains: ['blocks.example.com'],
        upstreams: [UPSTREAM],
        allowWebsocket: false,
        waf: WAF,
      },
      1,
    );
    return chainsTo(await buildCaddyDocument(), UPSTREAM);
  }

  it('runs ahead of every other handler, tagged blocked, and answers 403', async () => {
    const chains = await chainsWithBlocks();
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      const handlers = withoutMarkers(chain);
      const [addresses, geo, next] = handlers;
      expect(addresses).toMatchObject({
        handler: 'subroute',
        routes: [
          {
            match: [{ client_ip: { ranges: ['198.51.100.0/24', '203.0.113.7'] } }],
            handle: [{ handler: 'static_response', status_code: 403, body: 'Forbidden' }],
          },
        ],
      });
      expect(geo).toMatchObject({
        handler: 'blocker',
        block_countries: ['CN'],
        response_status: 403,
      });
      expect(handlerLabel(next as Handler)).toBe('ws-refuse');
      // The marker ahead of the deny list says blocked, never geo.
      const marker = chain[chain.indexOf(addresses as Handler) - 1];
      expect(marker).toEqual({ handler: 'vars', cpm_outcome: 'blocked' });
      expect(JSON.stringify(chain)).not.toContain('192.0.2.1');
    }
  });
});

describe('WAF exclusions in the build', () => {
  it('gives a host the global exclusions and its own', async () => {
    const host = await createProxyHost(
      {
        name: 'excl',
        domains: ['excl.example.com'],
        upstreams: [UPSTREAM],
        waf: { ...WAF, waf_mode: 'merge' },
      },
      1,
    );
    await ctx.db.insert(schema.wafExclusions).values([
      { ruleId: 942100, proxyHostId: null, reason: '', createdAt: NOW, updatedAt: NOW },
      {
        ruleId: 941100,
        proxyHostId: host.id,
        path: '/upload',
        reason: '',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const chains = chainsTo(await buildCaddyDocument(), UPSTREAM);
    const waf = chains.flat().find((h) => h.handler === 'waf');
    const directives = String(waf?.directives);
    expect(directives).toContain('SecRuleRemoveById 942100');
    expect(directives).toContain('"@streq /upload"');
    expect(directives).toContain('ctl:ruleRemoveById=941100');
  });
});
