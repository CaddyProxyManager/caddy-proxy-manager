import { describe, expect, it } from 'bun:test';
import {
  caddyDurationMs,
  defaultDynamicDnsSettings,
  normalizeDynamicDnsSettings,
  recordSetHostnames,
} from '@/src/lib/dns/dynamic-dns';
import { buildDynamicDnsApp, recordSetsFor } from '@/src/lib/dns/dynamic-dns-config';
import { encryptProviderCredentials } from '@/src/lib/dns/provider-credentials';
import { DomainError } from '@/src/lib/errors/domain-error';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
}

const set = (overrides: Record<string, unknown> = {}) => ({
  provider: 'cloudflare',
  zone: 'example.com',
  names: ['@', 'home'],
  agentId: null,
  ...overrides,
});

describe('normalizeDynamicDnsSettings', () => {
  it('fills defaults for an empty value', () => {
    expect(normalizeDynamicDnsSettings({})).toEqual(defaultDynamicDnsSettings());
  });

  it('turns pasted fully qualified names into names relative to the zone', () => {
    const normalized = normalizeDynamicDnsSettings({
      enabled: true,
      recordSets: [
        set({ zone: 'Example.com.', names: 'example.com, Home.example.com. *.lab home' }),
      ],
    });
    expect(normalized.recordSets).toEqual([
      { provider: 'cloudflare', zone: 'example.com', names: ['@', 'home', '*.lab'], agentId: null },
    ]);
    expect(recordSetHostnames(normalized.recordSets[0])).toEqual([
      'example.com',
      'home.example.com',
      '*.lab.example.com',
    ]);
  });

  it.each([
    [{ enabled: true, recordSets: [] }, 'dynamicDnsRecordSetsRequired'],
    [{ recordSets: [set({ provider: 'nope' })] }, 'dynamicDnsProviderUnknown'],
    [{ recordSets: [set({ provider: 'acmedns' })] }, 'dynamicDnsProviderUnsupported'],
    [{ recordSets: [set({ zone: 'localhost' })] }, 'dynamicDnsZoneInvalid'],
    [{ recordSets: [set({ names: [] })] }, 'dynamicDnsNamesRequired'],
    [{ recordSets: [set({ names: ['bad name!'] })] }, 'dynamicDnsNameInvalid'],
    [{ recordSets: [set({ names: ['a.*'] })] }, 'dynamicDnsNameInvalid'],
    [{ recordSets: [set({ agentId: 'has space' })] }, 'dynamicDnsAgentInvalid'],
    [{ ipv4: false, ipv6: false }, 'dynamicDnsNoIpVersion'],
    [{ checkInterval: '30s' }, 'dynamicDnsIntervalInvalid'],
    [{ checkInterval: '5' }, 'dynamicDnsIntervalInvalid'],
    [{ ttl: '500ms' }, 'dynamicDnsTtlInvalid'],
    [{ ipEndpoints: ['ftp://ip.example'] }, 'dynamicDnsEndpointInvalid'],
  ])('refuses %j with %s', (value, code) => {
    expect(codeOf(() => normalizeDynamicDnsSettings(value))).toBe(code);
  });

  it('reads Caddy durations as milliseconds', () => {
    expect(caddyDurationMs('1h30m')).toBe(5_400_000);
    expect(caddyDurationMs('1.5s')).toBe(1500);
    expect(caddyDurationMs('1d')).toBe(86_400_000);
  });
});

describe('recordSetsFor', () => {
  const settings = normalizeDynamicDnsSettings({
    enabled: true,
    recordSets: [set(), set({ zone: 'branch.example', agentId: 'agent-b' })],
  });

  it('gives a set without an agent to the bundled agent only', () => {
    const bundled = { agentId: 'agent-a', bundledAgentId: 'agent-a' };
    expect(recordSetsFor(settings, bundled).map((s) => s.zone)).toEqual(['example.com']);
    const other = { agentId: 'agent-b', bundledAgentId: 'agent-a' };
    expect(recordSetsFor(settings, other).map((s) => s.zone)).toEqual(['branch.example']);
  });

  it('gives it to the direct transport when no agent is bundled', () => {
    const direct = { agentId: null, bundledAgentId: null };
    expect(recordSetsFor(settings, direct).map((s) => s.zone)).toEqual(['example.com']);
    const remote = { agentId: 'agent-c', bundledAgentId: null };
    expect(recordSetsFor(settings, remote)).toEqual([]);
  });
});

describe('buildDynamicDnsApp', () => {
  const credentials = {
    cloudflare: encryptProviderCredentials('cloudflare', {
      api_token: 'cf-token',
      propagation_delay: '60s',
    }),
    porkbun: { api_key: 'pk', api_secret_key: 'sk' },
  };
  const target = { agentId: null, bundledAgentId: null };

  it('emits one provider entry per provider with decrypted credentials', () => {
    const settings = normalizeDynamicDnsSettings({
      enabled: true,
      recordSets: [
        set(),
        set({ names: ['vpn', 'home'] }),
        set({ zone: 'example.net', names: ['@'] }),
        set({ provider: 'porkbun', zone: 'example.org', names: ['@'] }),
      ],
      ipv6: true,
      checkInterval: '10m',
      ttl: '5m',
      updateOnly: true,
      ipEndpoints: ['https://icanhazip.com'],
    });
    const { app, skipped } = buildDynamicDnsApp(settings, {
      ...target,
      providerCredentials: credentials,
      isProviderUsable: () => true,
    });
    expect(skipped).toEqual([]);
    expect(app).toEqual({
      providers: [
        {
          // The challenge option stays out of the provider module's config.
          dns_provider: { name: 'cloudflare', api_token: 'cf-token' },
          domains: { 'example.com': ['@', 'home', 'vpn'], 'example.net': ['@'] },
        },
        {
          dns_provider: { name: 'porkbun', api_key: 'pk', api_secret_key: 'sk' },
          domains: { 'example.org': ['@'] },
        },
      ],
      versions: { ipv4: true, ipv6: true },
      check_interval: '10m',
      ttl: '5m',
      update_only: true,
      ip_sources: [{ source: 'simple_http', endpoints: ['https://icanhazip.com'] }],
    });
  });

  it('skips a set whose provider is unusable instead of failing the config', () => {
    const settings = normalizeDynamicDnsSettings({
      enabled: true,
      recordSets: [set(), set({ provider: 'porkbun', zone: 'example.org' })],
    });
    const { app, skipped } = buildDynamicDnsApp(settings, {
      ...target,
      providerCredentials: credentials,
      isProviderUsable: (provider) => provider === 'cloudflare',
    });
    expect(skipped.map((s) => s.provider)).toEqual(['porkbun']);
    expect(app?.providers).toHaveLength(1);
    expect(app).not.toHaveProperty('ip_sources');
    expect(app).not.toHaveProperty('ttl');
  });

  it('emits nothing while disabled or with nothing to update here', () => {
    const recordSets = [set()];
    const options = { ...target, providerCredentials: credentials, isProviderUsable: () => true };
    expect(buildDynamicDnsApp(normalizeDynamicDnsSettings({ recordSets }), options).app).toBeNull();
    expect(
      buildDynamicDnsApp(normalizeDynamicDnsSettings({ enabled: true, recordSets }), {
        ...options,
        agentId: 'agent-x',
      }).app,
    ).toBeNull();
  });
});
