/** Settings' host defaults fill what a create body leaves out, and nothing it sets. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { createL4ProxyHost } from '../../../src/lib/models/l4-proxy-hosts';
import { getHostDefaults, getSetting, saveHostDefaults } from '../../../src/lib/settings';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';
import { DEFAULT_HOST_DEFAULTS } from '../../../src/lib/proxy-hosts/host-defaults';

let admin = 0;

beforeEach(async () => {
  for (const table of [
    schema.hostRevisions,
    schema.proxyHosts,
    schema.l4ProxyHosts,
    schema.settings,
    schema.users,
  ]) {
    await ctx.db.delete(table);
  }
  invalidateSettingsCache();
  const now = new Date().toISOString();
  const [user] = await ctx.db
    .insert(schema.users)
    .values({
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  admin = user.id;
});

const CUSTOM = {
  proxyHost: {
    ...DEFAULT_HOST_DEFAULTS.proxyHost,
    sslForced: false,
    hstsEnabled: false,
    allowWebsocket: false,
    preserveHostHeader: false,
    skipHttpsValidation: true,
    discourageIndexing: true,
    compression: 'off' as const,
    crowdsecEnabled: false,
  },
  l4ProxyHost: {
    protocol: 'tcp' as const,
    tlsTermination: true,
    proxyProtocolReceive: true,
    crowdsecEnabled: false,
  },
};

describe('host defaults', () => {
  it('reads the shipped values while nothing is stored', async () => {
    expect(await getSetting('host_defaults')).toBeNull();
    expect(await getHostDefaults()).toEqual(DEFAULT_HOST_DEFAULTS);
  });

  it('leaves a create unchanged while nothing is stored', async () => {
    const host = await createProxyHost(
      { name: 'plain', domains: ['plain.example.com'], upstreams: ['app:8080'] },
      admin,
    );
    expect(host).toMatchObject({
      sslForced: true,
      hstsEnabled: true,
      hstsSubdomains: false,
      allowWebsocket: true,
      preserveHostHeader: true,
      skipHttpsHostnameValidation: false,
      discourageIndexing: false,
      compression: 'inherit',
      crowdsec: true,
    });
    const l4 = await createL4ProxyHost(
      { name: 'db', listenAddress: ':15432', upstreams: ['db:5432'] } as never,
      admin,
    );
    expect(l4).toMatchObject({
      protocol: 'tcp',
      tlsTermination: false,
      proxyProtocolReceive: false,
      crowdsec: true,
    });
  });

  it('fills the fields a proxy host body leaves out', async () => {
    await saveHostDefaults(CUSTOM);
    const host = await createProxyHost(
      { name: 'shop', domains: ['shop.example.com'], upstreams: ['app:8080'] },
      admin,
    );
    expect(host).toMatchObject({
      sslForced: false,
      hstsEnabled: false,
      allowWebsocket: false,
      preserveHostHeader: false,
      skipHttpsHostnameValidation: true,
      discourageIndexing: true,
      compression: 'off',
      crowdsec: false,
    });
  });

  it('keeps what a proxy host body sets', async () => {
    await saveHostDefaults(CUSTOM);
    const host = await createProxyHost(
      {
        name: 'blog',
        domains: ['blog.example.com'],
        upstreams: ['app:8080'],
        sslForced: true,
        allowWebsocket: true,
        discourageIndexing: false,
        compression: 'on',
        crowdsec: true,
      },
      admin,
    );
    expect(host).toMatchObject({
      sslForced: true,
      allowWebsocket: true,
      discourageIndexing: false,
      compression: 'on',
      crowdsec: true,
      // Left out, so still the default.
      preserveHostHeader: false,
    });
  });

  it('fills the fields an L4 body leaves out, protocol included', async () => {
    await saveHostDefaults(CUSTOM);
    const l4 = await createL4ProxyHost(
      { name: 'db', listenAddress: ':15432', upstreams: ['db:5432'] } as never,
      admin,
    );
    expect(l4).toMatchObject({
      protocol: 'tcp',
      tlsTermination: true,
      proxyProtocolReceive: true,
      crowdsec: false,
    });
  });

  it('keeps what an L4 body sets, and never terminates TLS over UDP', async () => {
    await saveHostDefaults(CUSTOM);
    const l4 = await createL4ProxyHost(
      {
        name: 'dns',
        protocol: 'udp',
        listenAddress: ':15353',
        upstreams: ['dns:53'],
        crowdsec: true,
      },
      admin,
    );
    expect(l4).toMatchObject({
      protocol: 'udp',
      tlsTermination: false,
      proxyProtocolReceive: true,
      crowdsec: true,
    });
  });
});
