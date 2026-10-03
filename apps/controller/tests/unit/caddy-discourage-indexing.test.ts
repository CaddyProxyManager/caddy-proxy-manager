/** "Discourage search engines": the header on every route shape, and robots.txt ahead of auth. */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost, getProxyHost, updateProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { buildNoIndexHandlers, ROBOTS_TXT_DISALLOW_ALL } from '../../src/lib/host-robots';
import { parseProxyHostOptionUpdates } from '../../src/lib/proxy-host-form';
import * as schema from '../../src/lib/db/schema';
import { chainLabels } from '../helpers/host-chains';

const NOW = new Date().toISOString();
const UPSTREAM = '10.0.0.5:8080';

async function labelsFor(domain: string, options: Record<string, unknown>) {
  await createProxyHost(
    {
      name: domain,
      domains: [domain],
      upstreams: [UPSTREAM],
      discourageIndexing: true,
      ...options,
    },
    1,
  );
  const labels = chainLabels(await buildCaddyDocument(), UPSTREAM);
  expect(labels.length).toBeGreaterThan(0);
  return labels;
}

/** Every chain carries both, after HSTS and ahead of the first proxy (an auth subrequest, if any). */
function expectNoIndexAheadOfAuth(chains: string[][]) {
  for (const labels of chains) {
    const header = labels.indexOf('x-robots-tag');
    const robots = labels.indexOf('robots');
    expect(header).toBeGreaterThanOrEqual(0);
    expect(robots).toBeGreaterThan(header);
    expect(robots).toBeLessThan(labels.indexOf('reverse_proxy'));
    if (labels.includes('hsts')) expect(header).toBeGreaterThan(labels.indexOf('hsts'));
  }
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

describe('handlers', () => {
  it('defers the header, so it replaces the upstream value', () => {
    const [header, robots] = buildNoIndexHandlers();
    expect(header).toEqual({
      handler: 'headers',
      response: { set: { 'X-Robots-Tag': ['noindex, nofollow'] }, deferred: true },
    });
    expect(JSON.stringify(robots)).toContain('"path":["/robots.txt"]');
    expect(ROBOTS_TXT_DISALLOW_ALL).toBe('User-agent: *\nDisallow: /\n');
  });
});

describe('route shapes', () => {
  it('a plain host with a location rule', async () => {
    expectNoIndexAheadOfAuth(
      await labelsFor('plain.example.com', {
        locationRules: [{ path: '/api/*', upstreams: [UPSTREAM] }],
      }),
    );
  });

  it('generic forward auth, protected paths included', async () => {
    const chains = await labelsFor('fa.example.com', {
      forwardAuth: {
        enabled: true,
        provider: 'authelia',
        authUpstream: 'http://authelia:9091',
        protectedPaths: ['/admin/*'],
      },
    });
    expect(chains.some((labels) => labels.filter((l) => l === 'reverse_proxy').length > 1)).toBe(
      true,
    );
    expectNoIndexAheadOfAuth(chains);
  });

  it('Authentik', async () => {
    expectNoIndexAheadOfAuth(
      await labelsFor('ak.example.com', {
        authentik: {
          enabled: true,
          outpostDomain: 'outpost.goauthentik.io',
          outpostUpstream: 'http://authentik-server:9000',
        },
      }),
    );
  });

  it('stays out of a host that did not ask', async () => {
    await createProxyHost(
      { name: 'indexed', domains: ['indexed.example.com'], upstreams: [UPSTREAM] },
      1,
    );
    const json = JSON.stringify(await buildCaddyDocument());
    expect(json).not.toContain('X-Robots-Tag');
    expect(json).not.toContain('/robots.txt');
  });
});

describe('storage', () => {
  it('round-trips, survives a form without the switch, and turns off', async () => {
    const host = await createProxyHost(
      {
        name: 'store',
        domains: ['store.example.com'],
        upstreams: [UPSTREAM],
        discourageIndexing: true,
      },
      1,
    );
    expect(host.discourageIndexing).toBe(true);

    await updateProxyHost(host.id, parseProxyHostOptionUpdates(new FormData()), 1);
    expect((await getProxyHost(host.id))?.discourageIndexing).toBe(true);

    const off = new FormData();
    off.set('discourageIndexingPresent', '1');
    await updateProxyHost(host.id, parseProxyHostOptionUpdates(off), 1);
    expect((await getProxyHost(host.id))?.discourageIndexing).toBe(false);
  });
});
