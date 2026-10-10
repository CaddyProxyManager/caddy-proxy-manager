/**
 * Regression: geoblockMode must round-trip through create/updateProxyHost. `parseGeoBlockConfig`
 * returned `geoblock_mode` while ProxyHostInput keys are camelCase, so the spread dropped it.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import {
  createProxyHost,
  updateProxyHost,
  getProxyHost,
  type ProxyHostInput,
} from '../../../src/lib/models/proxy-hosts';
import { parseProxyHostOptionUpdates } from '../../../src/lib/proxy-hosts/form';
import * as schema from '../../../src/lib/db/schema';

const baseGeoblock = {
  enabled: true,
  block_countries: [],
  block_continents: [],
  block_asns: [],
  block_cidrs: ['0.0.0.0/0'],
  block_ips: [],
  allow_countries: [],
  allow_continents: [],
  allow_asns: [],
  allow_cidrs: ['10.0.0.0/8'],
  allow_ips: [],
  trusted_proxies: [],
  fail_closed: false,
  response_status: 403,
  response_body: 'Forbidden',
  response_headers: {},
  redirect_url: '',
};

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    role: 'admin',
    provider: 'credentials',
    subject: 'test',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('proxy host geoblockMode persistence', () => {
  it('persists geoblockMode=override on create', async () => {
    const input: ProxyHostInput = {
      name: 'override-host',
      domains: ['override.example.com'],
      upstreams: ['10.0.0.5:8080'],
      geoblock: baseGeoblock,
      geoblockMode: 'override',
    };
    const host = await createProxyHost(input, 1);

    const fetched = await getProxyHost(host.id);
    expect(fetched?.geoblockMode).toBe('override');

    // Also verify raw meta JSON to catch normalization bugs.
    const row = await ctx.db.query.proxyHosts.findFirst({
      where: (t, { eq }) => eq(t.id, host.id),
    });
    expect(row?.meta).toBeDefined();
    expect(JSON.parse(row!.meta!).geoblock_mode).toBe('override');
  });

  it('refuses host rules the global validator would refuse', async () => {
    // The API hands the object to the model as-is; the form never sends a bad one.
    await expect(
      createProxyHost(
        {
          name: 'bad-host',
          domains: ['bad.example.com'],
          upstreams: ['10.0.0.5:8080'],
          geoblock: { ...baseGeoblock, trusted_proxies: ['not-a-cidr'] },
        },
        1,
      ),
    ).rejects.toMatchObject({ code: 'hostGeoBlockInvalid' });
  });

  it('defaults geoblockMode=merge when not provided', async () => {
    const host = await createProxyHost(
      {
        name: 'default-host',
        domains: ['default.example.com'],
        upstreams: ['10.0.0.5:8080'],
        geoblock: baseGeoblock,
      },
      1,
    );
    const fetched = await getProxyHost(host.id);
    expect(fetched?.geoblockMode).toBe('merge');
  });

  it('switches geoblockMode merge -> override via update', async () => {
    const host = await createProxyHost(
      {
        name: 'switch-host',
        domains: ['switch.example.com'],
        upstreams: ['10.0.0.5:8080'],
        geoblock: baseGeoblock,
        geoblockMode: 'merge',
      },
      1,
    );
    expect((await getProxyHost(host.id))?.geoblockMode).toBe('merge');

    await updateProxyHost(host.id, { geoblockMode: 'override' }, 1);
    expect((await getProxyHost(host.id))?.geoblockMode).toBe('override');
  });

  it('switches geoblockMode override -> merge via update', async () => {
    const host = await createProxyHost(
      {
        name: 'switch-host-2',
        domains: ['switch2.example.com'],
        upstreams: ['10.0.0.5:8080'],
        geoblock: baseGeoblock,
        geoblockMode: 'override',
      },
      1,
    );
    expect((await getProxyHost(host.id))?.geoblockMode).toBe('override');

    await updateProxyHost(host.id, { geoblockMode: 'merge' }, 1);
    expect((await getProxyHost(host.id))?.geoblockMode).toBe('merge');
  });

  it('keeps the rules and mode through an update form without the geoblock section', async () => {
    const host = await createProxyHost(
      {
        name: 'partial-host',
        domains: ['partial.example.com'],
        upstreams: ['10.0.0.5:8080'],
        geoblock: baseGeoblock,
        geoblockMode: 'override',
      },
      1,
    );
    const form = new FormData();
    form.set('sslForcedPresent', '1');
    await updateProxyHost(host.id, parseProxyHostOptionUpdates(form), 1);

    const fetched = await getProxyHost(host.id);
    expect(fetched?.geoblock).toEqual(baseGeoblock);
    expect(fetched?.geoblockMode).toBe('override');
  });
});
