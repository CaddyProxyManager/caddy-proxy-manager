/**
 * DNS provider credentials are encrypted wherever they are saved from - the REST API used to store
 * them as sent - and a startup pass encrypts the plaintext rows that left behind.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted out of the factory: a Bun mock factory must be synchronous, or the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import { settings, settingsRevisions } from '../../src/lib/db/schema';
import { encryptDnsProviderSettingCredentials } from '../../src/lib/dns-provider-credentials';
import { saveDnsProviderSettings } from '../../src/lib/settings';
import { encryptPlaintextDnsCredentials } from '../../src/lib/settings/plaintext-credentials';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../src/lib/secret';

async function stored(key: string): Promise<any> {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, key));
  return JSON.parse(row.value);
}

async function insertSetting(key: string, value: unknown) {
  await ctx.db
    .insert(settings)
    .values({ key, value: JSON.stringify(value), updatedAt: new Date().toISOString() });
}

beforeEach(async () => {
  await ctx.db.delete(settingsRevisions);
  await ctx.db.delete(settings);
});

describe('encryptDnsProviderSettingCredentials', () => {
  it('encrypts password fields in the multi-provider shape and leaves the rest', () => {
    const next = encryptDnsProviderSettingCredentials({
      providers: {
        route53: { access_key_id: 'AKIAEXAMPLE', secret_access_key: 'plain', region: 'eu-west-1' },
      },
      default: 'route53',
    });
    const route53 = next.providers.route53;
    expect(decryptSecret(route53.secret_access_key)).toBe('plain');
    expect(route53).toMatchObject({ access_key_id: 'AKIAEXAMPLE', region: 'eu-west-1' });
    expect(next.default).toBe('route53');
  });

  it('encrypts acme-dns account passwords and keeps delegations', () => {
    const next = encryptDnsProviderSettingCredentials({
      providers: { acmedns: {} },
      default: 'acmedns',
      delegations: [{ domain: 'example.com', provider: 'acmedns' }],
      acmeDnsAccounts: {
        'example.com': {
          username: 'user',
          password: 'plain-acmedns',
          subdomain: 'sub',
          fulldomain: 'sub.auth.example.net',
          server_url: 'https://auth.example.net',
        },
      },
    });
    const account = next.acmeDnsAccounts!['example.com'];
    expect(isEncryptedSecret(account.password)).toBe(true);
    expect(decryptSecret(account.password)).toBe('plain-acmedns');
    expect(account).toMatchObject({ username: 'user', subdomain: 'sub' });
    expect(next.delegations).toEqual([{ domain: 'example.com', provider: 'acmedns' }]);
    // Saved back as stored, nothing is encrypted twice.
    expect(encryptDnsProviderSettingCredentials(next)).toEqual(next);
  });

  it('encrypts the legacy single-provider shape', () => {
    const next = encryptDnsProviderSettingCredentials({
      provider: 'cloudflare',
      credentials: { api_token: 'plain' },
    }) as { credentials: { api_token: string } };
    expect(decryptSecret(next.credentials.api_token)).toBe('plain');
  });

  it('passes non-strings, encrypted values and other shapes through', () => {
    const encrypted = encryptSecret('already');
    const next = encryptDnsProviderSettingCredentials({
      providers: {
        cloudflare: { api_token: 42 as unknown as string },
        route53: { secret_access_key: encrypted },
      },
      default: null,
    });
    expect(next.providers.cloudflare.api_token).toBe(42 as unknown as string);
    expect(next.providers.route53.secret_access_key).toBe(encrypted);
    expect(encryptDnsProviderSettingCredentials(null)).toBeNull();
    expect(encryptDnsProviderSettingCredentials(['x'])).toEqual(['x']);
  });
});

describe('saveDnsProviderSettings', () => {
  it('stores password fields encrypted, as the REST API passes them in plaintext', async () => {
    await saveDnsProviderSettings({
      providers: { cloudflare: { api_token: 'rest-plaintext-token' } },
      default: 'cloudflare',
    });

    const value = await stored('dns_provider');
    expect(JSON.stringify(value)).not.toContain('rest-plaintext-token');
    expect(decryptSecret(value.providers.cloudflare.api_token)).toBe('rest-plaintext-token');
  });

  it('stores acme-dns account passwords encrypted', async () => {
    await saveDnsProviderSettings({
      providers: { acmedns: {} },
      default: 'acmedns',
      acmeDnsAccounts: {
        'example.com': {
          username: 'user',
          password: 'rest-acmedns-password',
          subdomain: 'sub',
          fulldomain: 'sub.auth.example.net',
          server_url: 'https://auth.example.net',
        },
      },
    });
    const value = await stored('dns_provider');
    expect(JSON.stringify(value)).not.toContain('rest-acmedns-password');
    expect(decryptSecret(value.acmeDnsAccounts['example.com'].password)).toBe(
      'rest-acmedns-password',
    );
  });

  it('does not encrypt twice when the stored value is saved back', async () => {
    await saveDnsProviderSettings({
      providers: { cloudflare: { api_token: 't' } },
      default: 'cloudflare',
    });
    const first = await stored('dns_provider');
    await saveDnsProviderSettings(first);
    expect(await stored('dns_provider')).toEqual(first);
  });
});

describe('encryptPlaintextDnsCredentials', () => {
  it('encrypts plaintext provider credentials and the legacy Cloudflare token', async () => {
    await insertSetting('dns_provider', {
      providers: {
        cloudflare: { api_token: 'plain-cloudflare-token' },
        route53: { access_key_id: 'AKIAEXAMPLE', secret_access_key: 'plain-route53-secret' },
      },
      default: 'cloudflare',
    });
    await insertSetting('cloudflare', { apiToken: 'plain-legacy-token', zoneId: 'zone-1' });

    expect(await encryptPlaintextDnsCredentials()).toBe(2);

    const provider = await stored('dns_provider');
    expect(decryptSecret(provider.providers.cloudflare.api_token)).toBe('plain-cloudflare-token');
    expect(decryptSecret(provider.providers.route53.secret_access_key)).toBe(
      'plain-route53-secret',
    );
    expect(provider.providers.route53.access_key_id).toBe('AKIAEXAMPLE');
    const cloudflare = await stored('cloudflare');
    expect(decryptSecret(cloudflare.apiToken)).toBe('plain-legacy-token');
    expect(cloudflare.zoneId).toBe('zone-1');

    expect(await encryptPlaintextDnsCredentials()).toBe(0);
  });

  it('encrypts plaintext credentials kept in revision history', async () => {
    const plaintext = JSON.stringify({
      providers: { cloudflare: { api_token: 'plain-old' } },
      default: 'cloudflare',
    });
    await ctx.db.insert(settingsRevisions).values({
      summary: 'dns_provider',
      keys: JSON.stringify(['dns_provider']),
      changes: JSON.stringify({ dns_provider: { before: plaintext, after: plaintext } }),
      outcome: 'applied',
      appliedAt: new Date().toISOString(),
    });

    expect(await encryptPlaintextDnsCredentials()).toBe(1);

    const [row] = await ctx.db.select().from(settingsRevisions);
    expect(row.changes).not.toContain('plain-old');
    const change = JSON.parse(row.changes!).dns_provider;
    const token = JSON.parse(change.before).providers.cloudflare.api_token;
    expect(isEncryptedSecret(token)).toBe(true);
    expect(decryptSecret(token)).toBe('plain-old');
    expect(await encryptPlaintextDnsCredentials()).toBe(0);
  });

  it('leaves already-encrypted rows alone', async () => {
    await saveDnsProviderSettings({
      providers: { cloudflare: { api_token: 't' } },
      default: 'cloudflare',
    });
    const before = await stored('dns_provider');
    expect(await encryptPlaintextDnsCredentials()).toBe(0);
    expect(await stored('dns_provider')).toEqual(before);
  });
});
