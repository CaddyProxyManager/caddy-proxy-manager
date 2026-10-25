import { describe, expect, it } from 'bun:test';
import {
  caddyDurationMs,
  defaultDynamicDnsSettings,
  dynamicDnsProviderOptions,
  hostRecordNames,
  isDynamicDnsHostname,
  normalizeDynamicDnsSettings,
  normalizeHostDynamicDnsInput,
  recordSetHostnames,
  sanitizeHostDynamicDns,
} from '@/src/lib/dns/dynamic-dns';
import { findDnsZone } from '@/src/lib/dns/host-dynamic-dns';
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

describe('host dynamic DNS', () => {
  it('normalizes a host config and keeps an empty zone for the lookup', () => {
    expect(
      normalizeHostDynamicDnsInput({
        enabled: true,
        provider: '',
        zone: 'Example.COM.',
        hostnames: 'Game.example.com. game.example.com, *.lab.example.com',
      }),
    ).toEqual({
      enabled: true,
      provider: null,
      zone: 'example.com',
      hostnames: ['game.example.com', '*.lab.example.com'],
    });
    expect(normalizeHostDynamicDnsInput({ enabled: true }).zone).toBe('');
  });

  it.each([
    [{ provider: 'acmedns' }, 'dynamicDnsProviderUnsupported'],
    [{ provider: 'nope' }, 'dynamicDnsProviderUnknown'],
    [{ zone: 'localhost' }, 'dynamicDnsZoneInvalid'],
    [{ hostnames: ['nodots'] }, 'dynamicDnsHostnameInvalid'],
  ])('refuses %j with %s', (value, code) => {
    expect(codeOf(() => normalizeHostDynamicDnsInput({ enabled: true, ...value }))).toBe(code);
  });

  it('reads a stored blob leniently', () => {
    expect(sanitizeHostDynamicDns({ enabled: true, provider: 'nope' })).toBeNull();
    expect(sanitizeHostDynamicDns('nonsense')).toBeNull();
  });

  it('names records relative to the zone and refuses one outside it', () => {
    expect(
      hostRecordNames(['example.com', 'App.example.com', '*.example.com'], 'example.com'),
    ).toEqual(['@', 'app', '*']);
    expect(codeOf(() => hostRecordNames(['app.example.net'], 'example.com'))).toBe(
      'dynamicDnsHostOutsideZone',
    );
  });

  it('skips domains that cannot hold an address record', () => {
    expect(
      ['app.example.com', '192.0.2.1', 'localhost', '*.example.com'].filter(isDynamicDnsHostname),
    ).toEqual(['app.example.com', '*.example.com']);
  });

  it('offers only providers that can hold an address, and a default only among them', () => {
    expect(
      dynamicDnsProviderOptions({
        providers: { cloudflare: {}, acmedns: {} },
        default: 'acmedns',
      }),
    ).toEqual({ choices: [{ name: 'cloudflare', displayName: 'Cloudflare' }], default: null });
  });
});

describe('findDnsZone', () => {
  const zones =
    (...names: string[]) =>
    async (name: string) => {
      if (!names.includes(name)) throw Object.assign(new Error('no SOA'), { code: 'ENODATA' });
      return {};
    };

  it('walks up to the nearest name with an SOA record', async () => {
    expect(await findDnsZone('a.b.example.co.uk', zones('example.co.uk'))).toBe('example.co.uk');
    expect(await findDnsZone('*.lab.example.com', zones('lab.example.com', 'example.com'))).toBe(
      'lab.example.com',
    );
  });

  it('never answers with a bare TLD, and null when nothing answers', async () => {
    expect(await findDnsZone('app.example.com', zones('com'))).toBeNull();
  });
});
