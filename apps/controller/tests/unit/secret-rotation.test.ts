/**
 * reencryptStoredSecrets moves every stored secret only an old key opens onto the current
 * SESSION_SECRET, wherever it sits: a whole column, inside settings JSON, inside a revision's
 * JSON-encoded copy of that JSON, and Better Auth's two-factor columns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { vi } from '@/tests/helpers/vi';
import {
  encryptUnderOtherSecret,
  OTHER_SESSION_SECRET,
} from '@/tests/helpers/encrypt-under-other-secret';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted out of the factory: a Bun mock factory must be synchronous, or the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));

import * as schema from '../../src/lib/db/schema';
import { config } from '../../src/lib/config';
import { decryptSecret, encryptSecret, reencryptSecret } from '../../src/lib/secret';
import { reencryptStoredSecrets } from '../../src/lib/secret-rotation';

const PLAINTEXT = {
  accessToken: 'oauth-access-token',
  refreshToken: 'oauth-refresh-token',
  idToken: 'oauth-id-token',
  clientId: 'provider-client-id',
  clientSecret: 'provider-client-secret',
  certificateKey: '-----BEGIN PRIVATE KEY-----\ncert\n-----END PRIVATE KEY-----',
  caKey: '-----BEGIN PRIVATE KEY-----\nca\n-----END PRIVATE KEY-----',
  agentSecret: 'agent-shared-secret',
  dnsToken: 'cloudflare-api-token',
  jsonStringToken: 'a-setting-that-is-one-token',
  revisionToken: 'cloudflare-api-token-in-history',
};
type Name = keyof typeof PLAINTEXT;
const ENC_COUNT = Object.keys(PLAINTEXT).length;
const OAUTH_TOKEN_COUNT = 3;
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const BACKUP_CODES = JSON.stringify(['code-1', 'code-2']);
/** two_factors.secret and backupCodes. */
const TWO_FACTOR_COUNT = 2;

const now = () => new Date().toISOString();

function dnsSetting(token: string) {
  return JSON.stringify({
    providers: { cloudflare: { api_token: token, zone: 'example.com' } },
    default: 'cloudflare',
  });
}

/** One value in every place that holds one, encrypted by `encrypt`. */
async function seed(encrypt: (value: string) => string, twoFactorKey: string) {
  const db = ctx.db;
  const [user] = await db
    .insert(schema.users)
    .values({ email: 'user@example.com', createdAt: now(), updatedAt: now() })
    .returning();
  await db.insert(schema.accounts).values({
    userId: user.id,
    accountId: 'sub-1',
    providerId: 'oidc',
    accessToken: encrypt(PLAINTEXT.accessToken),
    refreshToken: encrypt(PLAINTEXT.refreshToken),
    idToken: encrypt(PLAINTEXT.idToken),
    createdAt: now(),
    updatedAt: now(),
  });
  await db.insert(schema.oauthProviders).values({
    id: 'oidc',
    name: 'OIDC',
    clientId: encrypt(PLAINTEXT.clientId),
    clientSecret: encrypt(PLAINTEXT.clientSecret),
    createdAt: now(),
    updatedAt: now(),
  });
  await db.insert(schema.certificates).values({
    name: 'imported',
    type: 'imported',
    domainNames: '["app.example.com"]',
    privateKeyPem: encrypt(PLAINTEXT.certificateKey),
    createdAt: now(),
    updatedAt: now(),
  });
  await db.insert(schema.caCertificates).values({
    name: 'client CA',
    certificatePem: 'ca',
    privateKeyPem: encrypt(PLAINTEXT.caKey),
    createdAt: now(),
    updatedAt: now(),
  });
  await db.insert(schema.agents).values({
    name: 'edge',
    agentId: 'agent-1',
    secret: encrypt(PLAINTEXT.agentSecret),
    createdAt: now(),
    updatedAt: now(),
  });
  await db.insert(schema.settings).values([
    { key: 'dns_provider', value: dnsSetting(encrypt(PLAINTEXT.dnsToken)), updatedAt: now() },
    {
      key: 'one_token',
      value: JSON.stringify(encrypt(PLAINTEXT.jsonStringToken)),
      updatedAt: now(),
    },
    { key: 'general', value: JSON.stringify({ primaryDomain: 'example.com' }), updatedAt: now() },
  ]);
  const setting = dnsSetting(encrypt(PLAINTEXT.revisionToken));
  await db.insert(schema.settingsRevisions).values({
    summary: 'dns_provider',
    keys: '["dns_provider"]',
    changes: JSON.stringify({ dns_provider: { before: null, after: setting } }),
    outcome: 'applied',
    appliedAt: now(),
  });
  await db.insert(schema.twoFactors).values({
    userId: user.id,
    secret: await symmetricEncrypt({ key: twoFactorKey, data: TOTP_SECRET }),
    backupCodes: await symmetricEncrypt({ key: twoFactorKey, data: BACKUP_CODES }),
  });
}

/** Every `enc:v1:` value, keyed like PLAINTEXT. */
async function readStored(): Promise<Record<Name, string | null>> {
  const db = ctx.db;
  const [account] = await db.select().from(schema.accounts);
  const [provider] = await db.select().from(schema.oauthProviders);
  const [certificate] = await db.select().from(schema.certificates);
  const [ca] = await db.select().from(schema.caCertificates);
  const [agent] = await db.select().from(schema.agents);
  const rows = await db.select().from(schema.settings);
  const setting = (key: string) => JSON.parse(rows.find((row) => row.key === key)!.value);
  const [revision] = await db.select().from(schema.settingsRevisions);
  const after = JSON.parse(JSON.parse(revision.changes!).dns_provider.after);
  return {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    idToken: account.idToken,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    certificateKey: certificate.privateKeyPem,
    caKey: ca.privateKeyPem,
    agentSecret: agent.secret,
    dnsToken: setting('dns_provider').providers.cloudflare.api_token,
    jsonStringToken: setting('one_token'),
    revisionToken: after.providers.cloudflare.api_token,
  };
}

async function expectAllUnderCurrentKey() {
  const stored = await readStored();
  for (const [name, value] of Object.entries(stored)) {
    expect(reencryptSecret(value as string), name).toBeNull();
    expect(decryptSecret(value as string), name).toBe(PLAINTEXT[name as Name]);
  }
  const [twoFactor] = await ctx.db.select().from(schema.twoFactors);
  expect(await symmetricDecrypt({ key: config.sessionSecret, data: twoFactor.secret })).toBe(
    TOTP_SECRET,
  );
  expect(await symmetricDecrypt({ key: config.sessionSecret, data: twoFactor.backupCodes })).toBe(
    BACKUP_CODES,
  );
}

const nothing = { reencrypted: 0, failed: 0, clearedOAuthTokens: 0 };

beforeEach(async () => {
  for (const table of [
    schema.twoFactors,
    schema.accounts,
    schema.settingsRevisions,
    schema.users,
    schema.oauthProviders,
    schema.certificates,
    schema.caCertificates,
    schema.agents,
    schema.settings,
  ]) {
    await ctx.db.delete(table);
  }
  vi.stubEnv('SESSION_SECRET_PREVIOUS', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function spyOnWarnings(): () => string {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
}

describe('reencryptStoredSecrets', () => {
  it('re-encrypts values stored under SESSION_SECRET_PREVIOUS, in every table', async () => {
    await seed((value) => encryptUnderOtherSecret(value), OTHER_SESSION_SECRET);
    const before = await readStored();

    vi.stubEnv(
      'SESSION_SECRET_PREVIOUS',
      `another-old-secret-000000000000000,${OTHER_SESSION_SECRET}`,
    );
    expect(await reencryptStoredSecrets()).toEqual({
      reencrypted: ENC_COUNT + TWO_FACTOR_COUNT,
      failed: 0,
      clearedOAuthTokens: 0,
    });

    const after = await readStored();
    for (const name of Object.keys(PLAINTEXT) as Name[]) {
      expect(after[name], name).not.toBe(before[name]);
    }

    // The previous secret is no longer needed.
    vi.stubEnv('SESSION_SECRET_PREVIOUS', undefined);
    await expectAllUnderCurrentKey();

    const rows = await ctx.db.select().from(schema.settings);
    const general = rows.find((row) => row.key === 'general')!;
    expect(JSON.parse(general.value)).toEqual({ primaryDomain: 'example.com' });
    const dns = JSON.parse(rows.find((row) => row.key === 'dns_provider')!.value);
    expect(dns.providers.cloudflare.zone).toBe('example.com');
  });

  it('re-encrypts values stored under a refused placeholder secret without configuration', async () => {
    const placeholder = 'your-secure-session-secret-here-min-32-chars';
    await seed((value) => encryptUnderOtherSecret(value, placeholder), placeholder);

    expect(await reencryptStoredSecrets()).toEqual({
      reencrypted: ENC_COUNT + TWO_FACTOR_COUNT,
      failed: 0,
      clearedOAuthTokens: 0,
    });
    await expectAllUnderCurrentKey();
  });

  it('keeps and reports what it cannot decrypt, clearing OAuth account tokens instead', async () => {
    await seed((value) => encryptUnderOtherSecret(value), OTHER_SESSION_SECRET);
    const before = await readStored();

    const warnings = spyOnWarnings();
    expect(await reencryptStoredSecrets()).toEqual({
      reencrypted: 0,
      failed: ENC_COUNT - OAUTH_TOKEN_COUNT + TWO_FACTOR_COUNT,
      clearedOAuthTokens: OAUTH_TOKEN_COUNT,
    });
    expect(await readStored()).toEqual({
      ...before,
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
    expect(warnings()).toContain('oauth_providers oidc clientSecret cannot be decrypted');
    expect(warnings()).toContain('two_factors');
    expect(warnings()).not.toContain('accounts');

    // Supplying the old secret on a later start recovers the rest.
    vi.stubEnv('SESSION_SECRET_PREVIOUS', OTHER_SESSION_SECRET);
    expect(await reencryptStoredSecrets()).toEqual({
      reencrypted: ENC_COUNT - OAUTH_TOKEN_COUNT + TWO_FACTOR_COUNT,
      failed: 0,
      clearedOAuthTokens: 0,
    });
  });

  it('does nothing when every value already uses the current key', async () => {
    await seed(encryptSecret, config.sessionSecret);
    const before = await readStored();
    const settingsBefore = await ctx.db.select().from(schema.settings);
    const revisionsBefore = await ctx.db.select().from(schema.settingsRevisions);

    expect(await reencryptStoredSecrets()).toEqual(nothing);
    expect(await readStored()).toEqual(before);
    expect(await ctx.db.select().from(schema.settings)).toEqual(settingsBefore);
    expect(await ctx.db.select().from(schema.settingsRevisions)).toEqual(revisionsBefore);
  });

  it('is idempotent', async () => {
    await seed((value) => encryptUnderOtherSecret(value), OTHER_SESSION_SECRET);
    vi.stubEnv('SESSION_SECRET_PREVIOUS', OTHER_SESSION_SECRET);

    expect((await reencryptStoredSecrets()).reencrypted).toBe(ENC_COUNT + TWO_FACTOR_COUNT);
    const once = await readStored();
    expect(await reencryptStoredSecrets()).toEqual(nothing);
    expect(await readStored()).toEqual(once);
  });
});
