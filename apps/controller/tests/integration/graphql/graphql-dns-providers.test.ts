/**
 * DNS provider credentials over GraphQL: a save lands encrypted in the settings row and applies
 * Caddy, the default follows the dashboard's rules, nothing answers with a credential value, and a
 * non-admin is refused.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { capabilitiesOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { isEncryptedSecret } from '../../../src/lib/secrets';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';
import * as db from '../../../src/lib/db/schema';
import { type FakeCaddy, installFakeCaddy } from '../../helpers/caddy-admin';

const SECRET = 'cf-token-that-must-not-come-back';
const ROLE_REFUSED = "This account's role does not allow this request";

function contextFor(role: string | null): GraphQLContext {
  return {
    viewer: async () => {
      if (!role) throw new Error('Unauthorized');
      return { userId: 1, role, authMethod: 'bearer' as const };
    },
    access: async () => ({
      userId: 1,
      role: role ?? '',
      capabilities: capabilitiesOf(role),
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(
  document: string,
  role: string | null,
  variableValues?: Record<string, unknown>,
) {
  return await graphql({
    schema,
    source: document,
    contextValue: contextFor(role),
    variableValues,
  });
}

async function ok<T = Record<string, unknown>>(
  document: string,
  variableValues?: Record<string, unknown>,
): Promise<T> {
  const result = await run(document, 'admin', variableValues);
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

type Redacted = {
  providers: Record<string, { configuredFields: string[] }>;
  default: string | null;
};

const SAVE =
  'mutation ($provider: String!, $credentials: JSON!) { saveDnsProviderCredentials(provider: $provider, credentials: $credentials) }';

async function save(provider: string, credentials: Record<string, unknown>) {
  const data = await ok<{ saveDnsProviderCredentials: Redacted }>(SAVE, { provider, credentials });
  return data.saveDnsProviderCredentials;
}

async function stored(): Promise<{
  providers: Record<string, Record<string, string>>;
  default: string | null;
} | null> {
  const [row] = await ctx.db.select().from(db.settings).where(eq(db.settings.key, 'dns_provider'));
  return row ? JSON.parse(row.value) : null;
}

let caddy: FakeCaddy;

beforeEach(async () => {
  caddy = installFakeCaddy();
  await ctx.db.delete(db.settings);
  await ctx.db.delete(db.users);
  invalidateSettingsCache();
  await ctx.db.insert(db.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('saveDnsProviderCredentials', () => {
  it('stores the credentials encrypted, makes the first provider the default and applies Caddy', async () => {
    const redacted = await save('cloudflare', { api_token: SECRET, propagation_delay: '30s' });

    expect(redacted).toMatchObject({
      providers: { cloudflare: { configuredFields: ['api_token', 'propagation_delay'] } },
      default: 'cloudflare',
    });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);

    const row = await stored();
    expect(row?.default).toBe('cloudflare');
    expect(isEncryptedSecret(row?.providers.cloudflare.api_token ?? '')).toBe(true);
    expect(row?.providers.cloudflare.propagation_delay).toBe('30s');
    expect(caddy.loads.length).toBeGreaterThan(0);
  });

  it('keeps a stored secret when its field is left blank, and leaves the default alone', async () => {
    await save('cloudflare', { api_token: SECRET });
    const before = (await stored())?.providers.cloudflare.api_token;

    await save('route53', { access_key_id: 'AKIA', secret_access_key: 'aws-secret' });
    const redacted = await save('cloudflare', { api_token: '', propagation_timeout: '5m' });

    expect(redacted.default).toBe('cloudflare');
    const row = await stored();
    expect(row?.providers.cloudflare.api_token).toBe(before);
    expect(row?.providers.cloudflare.propagation_timeout).toBe('5m');
    expect(Object.keys(row?.providers ?? {}).sort()).toEqual(['cloudflare', 'route53']);
  });

  it('refuses an unknown provider, a missing required field and a bad duration, storing nothing', async () => {
    for (const [provider, credentials, message] of [
      ['not-a-provider', { api_token: SECRET }, 'Unknown DNS provider'],
      ['cloudflare', {}, 'api_token'],
      ['cloudflare', { api_token: SECRET, propagation_delay: 'soon' }, 'duration'],
      ['cloudflare', 'just-a-string', 'must be an object'],
    ] as const) {
      const result = await run(SAVE, 'admin', { provider, credentials });
      expect(result.errors?.[0]?.message, provider).toContain(message);
    }
    expect(await stored()).toBeNull();
    expect(caddy.loads).toEqual([]);
  });
});

describe('the default and removal', () => {
  it('moves the default only onto a configured provider, or clears it', async () => {
    await save('cloudflare', { api_token: SECRET });
    await save('route53', { access_key_id: 'AKIA', secret_access_key: 'aws-secret' });

    const moved = await ok<{ setDefaultDnsProvider: Redacted }>(
      'mutation { setDefaultDnsProvider(provider: "route53") }',
    );
    expect(moved.setDefaultDnsProvider.default).toBe('route53');
    expect((await stored())?.default).toBe('route53');

    const refused = await run('mutation { setDefaultDnsProvider(provider: "duckdns") }', 'admin');
    expect(refused.errors?.[0]?.message).toBe('DNS provider not configured');
    expect((await stored())?.default).toBe('route53');

    const cleared = await ok<{ setDefaultDnsProvider: Redacted }>(
      'mutation { setDefaultDnsProvider(provider: null) }',
    );
    expect(cleared.setDefaultDnsProvider.default).toBeNull();
    expect((await stored())?.default).toBeNull();
  });

  it('removes a provider, handing the default to one that remains', async () => {
    await save('cloudflare', { api_token: SECRET });
    await save('route53', { access_key_id: 'AKIA', secret_access_key: 'aws-secret' });

    const data = await ok<{ removeDnsProvider: Redacted }>(
      'mutation { removeDnsProvider(provider: "cloudflare") }',
    );
    expect(Object.keys(data.removeDnsProvider.providers)).toEqual(['route53']);
    expect(data.removeDnsProvider.default).toBe('route53');
    const row = await stored();
    expect(row?.providers).not.toHaveProperty('cloudflare');
    expect(row?.default).toBe('route53');

    const again = await run('mutation { removeDnsProvider(provider: "cloudflare") }', 'admin');
    expect(again.errors?.[0]?.message).toBe('DNS provider not configured');
  });
});

describe('what comes back', () => {
  it('never carries a credential value, over the mutation or the settings query', async () => {
    const saved = await save('cloudflare', { api_token: SECRET });
    const read = await ok<{ settings: Redacted; dnsProviders: { id: string }[] }>(
      '{ settings(group: "dns-provider") dnsProviders { id name configured } }',
    );
    for (const answer of [saved, read]) {
      expect(JSON.stringify(answer)).not.toContain(SECRET);
    }
    expect(read.settings.providers.cloudflare).toEqual({ configuredFields: ['api_token'] });
    // The stored row holds it, encrypted: the redaction happened on the way out, not on the way in.
    const encrypted = (await stored())?.providers.cloudflare.api_token ?? '';
    expect(encrypted).not.toBe(SECRET);
    expect(isEncryptedSecret(encrypted)).toBe(true);
  });
});

describe('the admin gate', () => {
  it('refuses an operator each mutation, writing nothing', async () => {
    for (const document of [
      'mutation { saveDnsProviderCredentials(provider: "cloudflare", credentials: { api_token: "x" }) }',
      'mutation { removeDnsProvider(provider: "cloudflare") }',
      'mutation { setDefaultDnsProvider(provider: null) }',
    ]) {
      const result = await run(document, 'operator');
      expect(result.errors?.[0]?.message, document).toBe(ROLE_REFUSED);
    }
    expect(await stored()).toBeNull();
    expect(caddy.loads).toEqual([]);
  });
});
