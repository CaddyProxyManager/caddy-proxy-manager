import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTlsAutomation } from '@/src/lib/caddy';
import type { AcmeSettings } from '@/src/lib/settings';

const NO_DNS = { enabled: false, resolvers: [] };

// Helper to reach the (only) auto-managed-domain issuer in the result.
async function firstIssuer(acmeSettings: AcmeSettings) {
  const result = await buildTlsAutomation(new Map(), new Set(['example.com']), {
    acmeEmail: 'admin@example.com',
    dnsSettings: NO_DNS,
    acmeSettings,
  });
  const policies = (result.tlsApp as any)?.automation?.policies as any[];
  return policies[0].issuers[0] as Record<string, unknown>;
}

describe('buildTlsAutomation - custom ACME directory', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'acme-ca-'));
    process.env.ACME_CA_ROOT_DIR = tmp;
  });

  afterEach(() => {
    delete process.env.ACME_CA_ROOT_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses the Let's Encrypt default (no ca field) when caUrl is unset", async () => {
    const issuer = await firstIssuer({});
    expect(issuer.module).toBe('acme');
    expect(issuer).not.toHaveProperty('ca');
    expect(issuer).not.toHaveProperty('trusted_roots_pem_files');
  });

  it('injects ca with a custom directory URL', async () => {
    const issuer = await firstIssuer({
      caUrl: 'https://ca.internal.example.com/acme/acme/directory',
    });
    expect(issuer.ca).toBe('https://ca.internal.example.com/acme/acme/directory');
  });

  it('ignores an empty/whitespace caUrl', async () => {
    const issuer = await firstIssuer({ caUrl: '   ' });
    expect(issuer).not.toHaveProperty('ca');
  });

  it('writes the CA root PEM to the shared path and references it', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const issuer = await firstIssuer({
      caUrl: 'https://ca.internal.example.com/acme/acme/directory',
      caRootPem: pem,
    });

    const expectedPath = join(tmp, 'custom-ca-root.pem');
    expect(issuer.trusted_roots_pem_files).toEqual([expectedPath]);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, 'utf-8')).toContain(pem);
  });

  it('applies the override to explicitly-managed certificate issuers too', async () => {
    const usage = new Map<number, any>([
      [
        1,
        {
          certificate: {
            id: 1,
            type: 'managed',
            autoRenew: true,
            domainNames: 'managed.example.com',
            providerOptions: null,
          },
          domains: new Set(['managed.example.com']),
        },
      ],
    ]);

    const result = await buildTlsAutomation(usage, new Set(), {
      dnsSettings: NO_DNS,
      acmeSettings: { caUrl: 'https://ca.internal.example.com/acme/acme/directory' },
    });

    const policies = (result.tlsApp as any).automation.policies as any[];
    const issuer = policies[0].issuers[0];
    expect(issuer.ca).toBe('https://ca.internal.example.com/acme/acme/directory');
  });
});

/**
 * Regression: DNS-01 challenges must keep their fallback resolvers. Dropping `fallbacks` leaves
 * validation with one resolver, so an unreachable primary silently breaks issuance and renewal.
 */
describe('buildTlsAutomation - DNS-01 challenge resolvers', () => {
  const DNS_PROVIDER = {
    default: 'cloudflare',
    providers: { cloudflare: { api_token: 'test-token' } },
  } as never;

  async function dnsChallenge(dnsSettings: unknown) {
    const result = await buildTlsAutomation(new Map(), new Set(['example.com']), {
      acmeEmail: 'admin@example.com',
      dnsSettings: dnsSettings as never,
      dnsProviderSettings: DNS_PROVIDER,
    });
    const policies = (result.tlsApp as any).automation.policies as any[];
    return policies[0].issuers[0].challenges.dns as { resolvers?: string[] };
  }

  it('appends fallback resolvers after the primaries', async () => {
    const challenge = await dnsChallenge({
      enabled: true,
      resolvers: ['1.1.1.1', '9.9.9.9'],
      fallbacks: ['1.0.0.1', '149.112.112.112'],
    });
    expect(challenge.resolvers).toEqual(['1.1.1.1', '9.9.9.9', '1.0.0.1', '149.112.112.112']);
  });

  // Regression: the column is JSON text, and was read as an object, so this fell back to HTTP-01.
  it("uses a managed certificate's own provider, as stored", async () => {
    const usage = new Map<number, any>([
      [
        1,
        {
          certificate: {
            id: 1,
            type: 'managed',
            autoRenew: true,
            domainNames: '["*.wild.example.com"]',
            providerOptions: JSON.stringify({ provider: 'rfc2136' }),
          },
          domains: new Set(['*.wild.example.com']),
        },
      ],
    ]);
    const result = await buildTlsAutomation(usage, new Set(), {
      dnsSettings: { enabled: false } as never,
      dnsProviderSettings: {
        default: null,
        providers: {
          rfc2136: {
            key_name: 'k',
            key_alg: 'hmac-sha256',
            key: 'c2VjcmV0',
            server: '10.0.0.53:53',
          },
        },
      } as never,
    });
    const policies = (result.tlsApp as any).automation.policies as any[];
    expect(policies[0].issuers[0].challenges.dns.provider).toMatchObject({
      name: 'rfc2136',
      server: '10.0.0.53:53',
    });
  });

  it('omits resolvers entirely when DNS settings are disabled', async () => {
    const challenge = await dnsChallenge({
      enabled: false,
      resolvers: ['1.1.1.1'],
      fallbacks: ['9.9.9.9'],
    });
    expect(challenge.resolvers).toBeUndefined();
  });
});
