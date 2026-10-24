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
import { CADDY_MODULES } from '../../../src/lib/caddy/image-build/modules';
import {
  getDynamicDnsSettings,
  saveCaddyBuildSettings,
  saveDnsProviderSettings,
  saveDynamicDnsSettings,
} from '../../../src/lib/settings';
import { defaultDynamicDnsSettings } from '../../../src/lib/dns/dynamic-dns';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { startFakeAgent } from '../../helpers/fake-agent';
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
