/** Dynamic DNS in a built document: the app with saved credentials, and absence without the module. */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { buildCaddyDocument } from '../../../src/lib/caddy';
import { CADDY_MODULES, DYNAMIC_DNS_MODULE_ID } from '../../../src/lib/caddy/image-build/modules';
import {
  ensureDynamicDnsModule,
  resolveEnabledModuleIds,
} from '../../../src/lib/caddy/image-build';
import { findModuleConflicts } from '../../../src/lib/caddy/image-build/conflicts';
import {
  getCaddyBuildSettings,
  getDynamicDnsSettings,
  saveCaddyBuildSettings,
  saveDnsProviderSettings,
  saveDynamicDnsSettings,
} from '../../../src/lib/settings';
import { defaultDynamicDnsSettings } from '../../../src/lib/dns/dynamic-dns';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { startFakeAgent } from '../../helpers/fake-agent';
import { createProxyHost } from '../../../src/lib/models/proxy-hosts';
import { createL4ProxyHost } from '../../../src/lib/models/l4-proxy-hosts';
import * as schema from '../../../src/lib/db/schema';

const ALL_MODULE_PATHS = CADDY_MODULES.map((m) => m.modulePath);

let agent: Awaited<ReturnType<typeof startFakeAgent>>;

async function withModules(applied: string[], disabledIds: string[] = []) {
  agent.state.appliedModules = applied;
  await saveCaddyBuildSettings({
    modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, !disabledIds.includes(m.id)])),
    customModules: [],
  });
}

const SETTINGS = {
  ...defaultDynamicDnsSettings(),
  enabled: true,
  recordSets: [{ provider: 'cloudflare', zone: 'example.com', names: ['home'], agentId: null }],
};

async function dynamicDnsApp(): Promise<unknown> {
  const doc = (await buildCaddyDocument()) as { apps: Record<string, unknown> };
  return doc.apps.dynamic_dns;
}

beforeEach(async () => {
  agent = await startFakeAgent();
  await ctx.db.delete(schema.settings);
  await saveDnsProviderSettings({
    providers: { cloudflare: { api_token: 'cf-token' } },
    default: 'cloudflare',
  });
});

afterEach(async () => {
  await agent.stop();
});

describe('dynamic DNS in the document', () => {
  it('emits the app with the decrypted provider credentials', async () => {
    await withModules(ALL_MODULE_PATHS);
    await saveDynamicDnsSettings(SETTINGS);
    expect(await dynamicDnsApp()).toEqual({
      providers: [
        {
          dns_provider: { name: 'cloudflare', api_token: 'cf-token' },
          domains: { 'example.com': ['home'] },
        },
      ],
      versions: { ipv4: true, ipv6: false },
      check_interval: '5m',
    });
  });

  it('emits nothing while the module is not compiled in', async () => {
    await withModules(ALL_MODULE_PATHS.filter((p) => p !== 'github.com/mholt/caddy-dynamicdns'));
    await saveDynamicDnsSettings(SETTINGS);
    expect(await dynamicDnsApp()).toBeUndefined();
  });

  it('emits nothing while the module is deselected', async () => {
    await withModules(ALL_MODULE_PATHS, ['caddy-dynamicdns']);
    await saveDynamicDnsSettings(SETTINGS);
    expect(await dynamicDnsApp()).toBeUndefined();
  });

  it('refuses a provider without saved credentials', async () => {
    const error = await saveDynamicDnsSettings({
      ...SETTINGS,
      recordSets: [{ provider: 'porkbun', zone: 'example.org', names: ['@'], agentId: null }],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('dynamicDnsProviderNotConfigured');
    expect((await getDynamicDnsSettings()).enabled).toBe(false);
  });
});

describe('the Dynamic DNS module selection', () => {
  const selected = async () =>
    resolveEnabledModuleIds(await getCaddyBuildSettings()).includes(DYNAMIC_DNS_MODULE_ID);

  it('selects the module while dynamic DNS is on, as after an upgrade', async () => {
    await withModules(ALL_MODULE_PATHS, [DYNAMIC_DNS_MODULE_ID]);
    await saveDynamicDnsSettings(SETTINGS);
    expect(await selected()).toBe(false);
    expect(await ensureDynamicDnsModule()).toBe(true);
    expect(await selected()).toBe(true);
  });

  it('leaves the selection alone while dynamic DNS is off', async () => {
    await withModules(ALL_MODULE_PATHS, [DYNAMIC_DNS_MODULE_ID]);
    await saveDynamicDnsSettings({ ...SETTINGS, enabled: false });
    expect(await ensureDynamicDnsModule()).toBe(false);
    expect(await selected()).toBe(false);
  });

  it('refuses dropping the module while dynamic DNS is on', async () => {
    await withModules(ALL_MODULE_PATHS);
    const settings = await getCaddyBuildSettings();
    const without = {
      ...settings!,
      modules: { ...settings!.modules, [DYNAMIC_DNS_MODULE_ID]: false },
    };
    await saveDynamicDnsSettings(SETTINGS);
    expect(await findModuleConflicts(without)).toContainEqual({ kind: 'globalDynamicDns' });
    await saveDynamicDnsSettings({ ...SETTINGS, enabled: false });
    expect(await findModuleConflicts(without)).not.toContainEqual({ kind: 'globalDynamicDns' });
  });
});

describe('dynamic DNS on a host', () => {
  const NOW = new Date().toISOString();

  beforeEach(async () => {
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
      createdAt: NOW,
      updatedAt: NOW,
    });
    await withModules(ALL_MODULE_PATHS);
  });

  const proxyHost = (dynamicDns: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    createProxyHost(
      {
        name: 'home',
        domains: ['home.example.com', 'example.com', '192.0.2.1'],
        upstreams: ['10.0.0.5:8080'],
        dynamicDns,
        ...extra,
      },
      1,
    );

  it('updates a proxy host its own domains, with the default provider and settings', async () => {
    const host = await proxyHost({ enabled: true, zone: 'example.com' });
    expect(host.dynamicDns).toEqual({
      enabled: true,
      provider: null,
      zone: 'example.com',
      hostnames: [],
    });
    expect(await dynamicDnsApp()).toEqual({
      providers: [
        {
          dns_provider: { name: 'cloudflare', api_token: 'cf-token' },
          domains: { 'example.com': ['home', '@'] },
        },
      ],
      versions: { ipv4: true, ipv6: false },
      check_interval: '5m',
    });
  });

  it('updates an L4 host the hostnames it lists', async () => {
    await createL4ProxyHost(
      {
        name: 'game',
        protocol: 'udp',
        listenAddress: ':27015',
        upstreams: ['game:27015'],
        dynamicDns: { enabled: true, zone: 'example.com', hostnames: ['play.example.com'] },
      },
      1,
    );
    expect(await dynamicDnsApp()).toMatchObject({
      providers: [{ domains: { 'example.com': ['play'] } }],
    });
  });

  it('keeps it while off and emits nothing', async () => {
    const host = await proxyHost({ enabled: false, zone: 'example.com' });
    expect(host.dynamicDns?.zone).toBe('example.com');
    expect(await dynamicDnsApp()).toBeUndefined();
  });

  it('refuses a domain outside the zone, and no provider to use', async () => {
    const outside = await proxyHost({ enabled: true, zone: 'example.net' }).catch((e) => e);
    expect((outside as DomainError).code).toBe('dynamicDnsHostOutsideZone');
    await saveDnsProviderSettings({ providers: {}, default: null });
    const none = await proxyHost({ enabled: true, zone: 'example.com' }).catch((e) => e);
    expect((none as DomainError).code).toBe('dynamicDnsNoDefaultProvider');
  });

  it('goes to the agent the host is pinned to, never also to the bundled one', async () => {
    const [row] = await ctx.db
      .insert(schema.agents)
      .values({
        name: 'branch',
        agentId: agent.agentId,
        secret: 'unused',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: schema.agents.id });
    await proxyHost({ enabled: true, zone: 'example.com' }, { agentIds: [row.id] });
    const pinned = (await buildCaddyDocument(row.id)) as { apps: Record<string, unknown> };
    expect(pinned.apps.dynamic_dns).toBeDefined();
    expect(await dynamicDnsApp()).toBeUndefined();
  });

  it('selects the module for a host alone, and refuses dropping it', async () => {
    await withModules(ALL_MODULE_PATHS, [DYNAMIC_DNS_MODULE_ID]);
    await proxyHost({ enabled: true, zone: 'example.com' });
    expect(resolveEnabledModuleIds(await getCaddyBuildSettings())).toContain(DYNAMIC_DNS_MODULE_ID);
    const settings = await getCaddyBuildSettings();
    const without = {
      ...settings!,
      modules: { ...settings!.modules, [DYNAMIC_DNS_MODULE_ID]: false },
    };
    expect(await findModuleConflicts(without)).toContainEqual({ kind: 'globalDynamicDns' });
  });
});
