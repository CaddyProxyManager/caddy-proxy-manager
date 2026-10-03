/**
 * `override_domain` covers a whole automation policy and certmagic does not follow CNAMEs, so a
 * policy mixing delegated and undelegated names would write the TXT record in the wrong place.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { buildTlsAutomation } from '@/src/lib/caddy';
import {
  challengeBaseName,
  expectedDelegationTarget,
  matchDelegation,
  partitionDnsChallenges,
} from '@/src/lib/dns-challenge-delegation';
import { checkDelegations } from '@/src/lib/dns-delegation-check';
import { encryptSecret } from '@/src/lib/secret';
import { CADDY_MODULES } from '@/src/lib/caddy-modules';

const cloudflare = CADDY_MODULES.find((m) => m.dnsProvider === 'cloudflare')!;

const NO_DNS = { enabled: false, resolvers: [] };

async function policiesFor(domains: string[], dnsProviderSettings: unknown, usage = new Map()) {
  const result = await buildTlsAutomation(usage, new Set(domains), {
    dnsSettings: NO_DNS,
    dnsProviderSettings: dnsProviderSettings as never,
  });
  return ((result.tlsApp as any)?.automation?.policies ?? []) as any[];
}

function dnsOf(policies: any[], subject: string) {
  const policy = policies.find((p) => p.subjects?.includes(subject));
  expect(policy).toBeDefined();
  return policy.issuers[0].challenges?.dns as Record<string, any> | undefined;
}

const ACCOUNT = {
  username: 'acmedns-user',
  password: encryptSecret('acmedns-pass'),
  subdomain: 'abc',
  fulldomain: 'abc.auth.example.net',
  server_url: 'https://auth.example.net',
};

describe('matchDelegation', () => {
  const delegations = [
    { domain: 'example.com', provider: 'cloudflare' },
    { domain: 'deep.example.com', target: 'deep.zone.example.net' },
  ];

  it('picks the longest matching suffix, and a wildcard matches through its parent', () => {
    expect(matchDelegation('a.deep.example.com', delegations)?.domain).toBe('deep.example.com');
    expect(matchDelegation('*.deep.example.com', delegations)?.domain).toBe('deep.example.com');
    expect(matchDelegation('*.example.com', delegations)?.domain).toBe('example.com');
    expect(matchDelegation('example.com', delegations)?.domain).toBe('example.com');
    // A suffix match is on a label boundary.
    expect(matchDelegation('notexample.com', delegations)).toBeNull();
  });

  it('strips the wildcard label for the challenge name', () => {
    expect(challengeBaseName('*.Example.COM.')).toBe('example.com');
  });
});

describe('buildTlsAutomation - challenge delegation', () => {
  const settings = {
    providers: { cloudflare: { api_token: 'cf' }, route53: { region: 'eu-west-1' } },
    default: 'cloudflare',
    delegations: [
      { domain: 'delegated.example', target: '_acme-challenge.delegated.zone.example.net' },
      { domain: 'other.example', target: 'other.zone.example.net', provider: 'route53' },
    ],
  };

  it('keeps one policy with no override when nothing is delegated', async () => {
    const policies = await policiesFor(['a.example.com', 'b.example.com'], {
      providers: settings.providers,
      default: 'cloudflare',
    });
    expect(policies).toHaveLength(1);
    expect(policies[0].subjects.sort()).toEqual(['a.example.com', 'b.example.com']);
    expect(policies[0].issuers[0].challenges.dns).not.toHaveProperty('override_domain');
  });

  it('splits a mixed group and sets override_domain per partition', async () => {
    const policies = await policiesFor(
      ['plain.example.com', 'www.delegated.example', 'app.other.example'],
      settings,
    );
    expect(policies).toHaveLength(3);
    expect(dnsOf(policies, 'plain.example.com')).not.toHaveProperty('override_domain');
    expect(dnsOf(policies, 'www.delegated.example')?.override_domain).toBe(
      '_acme-challenge.delegated.zone.example.net',
    );
    expect(dnsOf(policies, 'www.delegated.example')?.provider.name).toBe('cloudflare');
    // The delegation's provider overrides the default.
    expect(dnsOf(policies, 'app.other.example')?.override_domain).toBe('other.zone.example.net');
    expect(dnsOf(policies, 'app.other.example')?.provider).toEqual({
      name: 'route53',
      region: 'eu-west-1',
    });
    for (const policy of policies) {
      expect(policy.subjects).toHaveLength(1);
    }
  });

  it('gives a wildcard and its apex the same delegation', async () => {
    const policies = await policiesFor(['*.delegated.example', 'delegated.example'], settings);
    expect(dnsOf(policies, '*.delegated.example')?.override_domain).toBe(
      '_acme-challenge.delegated.zone.example.net',
    );
    expect(dnsOf(policies, 'delegated.example')?.override_domain).toBe(
      '_acme-challenge.delegated.zone.example.net',
    );
  });

  it('applies to managed certificates too, and a delegation provider beats the certificate one', async () => {
    const usage = new Map<number, any>([
      [
        7,
        {
          certificate: {
            id: 7,
            type: 'managed',
            autoRenew: true,
            providerOptions: { provider: 'cloudflare' },
          },
          domains: new Set(['x.other.example', 'x.example.com']),
        },
      ],
    ]);
    const result = await buildTlsAutomation(usage, new Set<string>(), {
      dnsSettings: NO_DNS,
      dnsProviderSettings: settings as never,
    });
    const policies = (result.tlsApp as any).automation.policies as any[];
    expect(dnsOf(policies, 'x.other.example')?.provider.name).toBe('route53');
    expect(dnsOf(policies, 'x.example.com')?.provider.name).toBe('cloudflare');
    expect(result.managedCertificateIds.has(7)).toBe(true);
  });

  it('drops DNS-01 for a delegated name whose provider is unusable, with a warning', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await buildTlsAutomation(
        new Map(),
        new Set(['app.other.example', 'a.example.com']),
        {
          dnsSettings: NO_DNS,
          dnsProviderSettings: settings as never,
          // route53's module is not compiled in.
          moduleAvailability: {
            desired: new Set(),
            applied: new Set(),
            appliedPaths: new Set([cloudflare.modulePath]),
            desiredIds: new Set([cloudflare.id]),
          } as never,
        },
      );
      const policies = (result.tlsApp as any).automation.policies as any[];
      expect(dnsOf(policies, 'app.other.example')).toBeUndefined();
      expect(dnsOf(policies, 'a.example.com')?.provider.name).toBe('cloudflare');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('buildTlsAutomation - acme-dns accounts', () => {
  it('emits the module config map keyed by challenge name, with passwords decrypted', async () => {
    const policies = await policiesFor(['*.example.com', 'example.com', 'app.example.com'], {
      providers: { acmedns: {} },
      default: null,
      delegations: [{ domain: 'example.com', provider: 'acmedns' }],
      acmeDnsAccounts: { 'example.com': ACCOUNT },
    });
    const dns = dnsOf(policies, 'app.example.com')!;
    expect(dns).not.toHaveProperty('override_domain');
    expect(dns.provider.name).toBe('acmedns');
    expect(dns.provider).not.toHaveProperty('username');
    // The subdomain falls back to its parent's account; the CNAME it needs points there too.
    expect(dns.provider.config['app.example.com']).toEqual({
      username: 'acmedns-user',
      password: 'acmedns-pass',
      subdomain: 'abc',
      fulldomain: 'abc.auth.example.net',
      server_url: 'https://auth.example.net',
    });
    const apex = dnsOf(policies, 'example.com')!;
    expect(Object.keys(apex.provider.config)).toEqual(['example.com']);
    // The wildcard's challenge is at the apex's name, so it shares the account.
    expect(Object.keys(dnsOf(policies, '*.example.com')!.provider.config)).toEqual(['example.com']);
    expect(JSON.stringify(policies)).not.toContain(ACCOUNT.password);
  });

  it('writes at a target through the account registered for the delegation', async () => {
    const policies = await policiesFor(['example.com', 'app.example.com'], {
      providers: { acmedns: {} },
      default: null,
      delegations: [{ domain: 'example.com', target: ACCOUNT.fulldomain, provider: 'acmedns' }],
      acmeDnsAccounts: { 'example.com': ACCOUNT },
    });
    for (const subject of ['example.com', 'app.example.com']) {
      const dns = dnsOf(policies, subject)!;
      expect(dns.override_domain).toBe(ACCOUNT.fulldomain);
      // The module looks the account up by the name it writes, which is the target.
      expect(dns.provider.config).toEqual({
        [ACCOUNT.fulldomain]: { ...ACCOUNT, password: 'acmedns-pass' },
      });
    }
  });

  it('fills names without an account from the single account, and drops them without one', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const withSingle = await policiesFor(['a.example.com', 'b.example.org'], {
        providers: {
          acmedns: {
            username: 'single',
            password: encryptSecret('single-pass'),
            subdomain: 'single-sub',
            server_url: 'https://auth.example.net',
          },
        },
        default: 'acmedns',
        acmeDnsAccounts: { 'example.com': ACCOUNT },
      });
      expect(withSingle).toHaveLength(1);
      const config = dnsOf(withSingle, 'b.example.org')!.provider.config;
      expect(config['b.example.org']).toMatchObject({
        username: 'single',
        password: 'single-pass',
      });
      expect(config['a.example.com']).toMatchObject({ username: 'acmedns-user' });

      const without = await policiesFor(['a.example.com', 'b.example.org'], {
        providers: { acmedns: {} },
        default: 'acmedns',
        acmeDnsAccounts: { 'example.com': ACCOUNT },
      });
      expect(dnsOf(without, 'b.example.org')).toBeUndefined();
      expect(dnsOf(without, 'a.example.com')?.provider.config).toHaveProperty(['a.example.com']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the single-account shape when no per-domain accounts exist', async () => {
    const policies = await policiesFor(['a.example.com'], {
      providers: {
        acmedns: {
          username: 'single',
          password: 'single-pass',
          subdomain: 'sub',
          server_url: 'https://auth.example.net',
        },
      },
      default: 'acmedns',
    });
    expect(dnsOf(policies, 'a.example.com')?.provider).toEqual({
      name: 'acmedns',
      username: 'single',
      password: 'single-pass',
      subdomain: 'sub',
      server_url: 'https://auth.example.net',
    });
  });
});

describe('partitionDnsChallenges', () => {
  it('keeps subjects without any provider together, with no DNS challenge', () => {
    const partitions = partitionDnsChallenges(
      ['a.example.com', 'b.example.com'],
      { providers: {} },
      null,
      () => true,
      () => {},
    );
    expect(partitions).toEqual([
      {
        subjects: ['a.example.com', 'b.example.com'],
        provider: null,
        target: null,
        acmeDnsConfig: null,
      },
    ]);
  });
});

describe('checkDelegations', () => {
  it('compares each _acme-challenge CNAME with what the delegation needs', async () => {
    const answers: Record<string, string[]> = {
      '_acme-challenge.ok.example': ['Target.Zone.Example.net.'],
      '_acme-challenge.wrong.example': ['elsewhere.example.net'],
    };
    const checks = await checkDelegations(
      [
        { domain: 'ok.example', target: 'target.zone.example.net' },
        { domain: 'wrong.example', target: 'target.zone.example.net' },
        { domain: 'missing.example', target: 'target.zone.example.net' },
        { domain: 'acme.example', provider: 'acmedns' },
        { domain: 'provider-only.example', provider: 'cloudflare' },
      ],
      { 'acme.example': { fulldomain: 'abc.auth.example.net' } },
      async (name) => answers[name] ?? [],
    );
    expect(checks.map((check) => [check.domain, check.status])).toEqual([
      ['ok.example', 'ok'],
      ['wrong.example', 'mismatch'],
      ['missing.example', 'missing'],
      ['acme.example', 'missing'],
      ['provider-only.example', 'none'],
    ]);
    expect(checks[3].expected).toBe('abc.auth.example.net');
  });

  it('expects the acme-dns account for an acme-dns delegation', () => {
    expect(
      expectedDelegationTarget(
        { domain: 'example.com', provider: 'acmedns' },
        { 'example.com': { fulldomain: 'x.auth.example.net' } },
      ),
    ).toBe('x.auth.example.net');
  });
});
