/**
 * OIDC providers over GraphQL: writes are read back from the database, the client secret never
 * comes back, the client id is redacted, and a non-admin is refused.
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

// Better Auth is rebuilt from the rows on the next request; here only the signal matters.
const invalidateProviderCache = vi.fn();
vi.mock('../../../src/lib/auth/server', () => ({ invalidateProviderCache }));

import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import * as db from '../../../src/lib/db/schema';
import { createOAuthProvider } from '../../../src/lib/models/oauth-providers';

const NOW = '2026-03-01T00:00:00.000Z';
const SECRET = 'client-secret-value';

function contextFor(role: string): GraphQLContext {
  return {
    viewer: async () => ({ userId: 1, role, authMethod: 'bearer' as const }),
    access: async () => ({
      userId: 1,
      role,
      capabilities: capabilitiesOf(role),
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(document: string, role = 'admin', variableValues?: Record<string, unknown>) {
  return graphql({ schema, source: document, contextValue: contextFor(role), variableValues });
}

async function ok<T = Record<string, unknown>>(document: string, vars?: Record<string, unknown>) {
  const result = await run(document, 'admin', vars);
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

const INPUT = {
  name: 'Keycloak',
  clientId: 'cpm-dashboard',
  clientSecret: SECRET,
  issuer: 'https://id.example.com/realms/cpm',
};

beforeEach(async () => {
  // One schema for the file: a connection per test would crowd a shared server.
  for (const table of [db.auditEvents, db.oauthProviders, db.users]) {
    await ctx.db.delete(table);
  }
  invalidateProviderCache.mockClear();
  await ctx.db.insert(db.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    subject: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('the admin gate', () => {
  it('refuses every mutation to an operator, and writes nothing', async () => {
    for (const document of [
      'mutation ($input: JSON!) { createOAuthProvider(input: $input) { id } }',
      'mutation ($input: JSON!) { updateOAuthProvider(id: "x", input: $input) { id } }',
      'mutation { deleteOAuthProvider(id: "x") }',
    ]) {
      const result = await run(document, 'operator', { input: INPUT });
      expect(result.errors?.[0]?.message, document).toContain(
        "This account's role does not allow this request",
      );
    }
    expect(await ctx.db.select().from(db.oauthProviders)).toEqual([]);
  });
});

describe('OIDC providers', () => {
  it('creates one, never answering with the secret and redacting the client id', async () => {
    const created = await ok<{ createOAuthProvider: Record<string, unknown> }>(
      `mutation ($input: JSON!) {
        createOAuthProvider(input: $input) {
          id name type clientId hasClientSecret callbackUrl issuer scopes enabled source
        }
      }`,
      { input: INPUT },
    );
    const provider = created.createOAuthProvider;
    expect(provider).toMatchObject({
      name: 'Keycloak',
      type: 'oidc',
      clientId: '••••oard',
      hasClientSecret: true,
      issuer: INPUT.issuer,
      scopes: 'openid email profile',
      enabled: true,
      source: 'ui',
    });
    expect(String(provider.callbackUrl)).toMatch(
      new RegExp(`/api/auth/callback/${encodeURIComponent(String(provider.id))}$`),
    );
    expect(invalidateProviderCache).toHaveBeenCalledTimes(1);

    const [row] = await ctx.db.select().from(db.oauthProviders);
    expect(provider.id).toBe(row.id);
    // Encrypted at rest: the stored column is not the value sent.
    expect(row.clientSecret).not.toBe(SECRET);
    expect(row.clientSecret).not.toBe('');

    // The schema has no field for it, on the list or the mutation.
    for (const document of [
      '{ oauthProviders { clientSecret } }',
      'mutation ($input: JSON!) { createOAuthProvider(input: $input) { clientSecret } }',
    ]) {
      const result = await run(document, 'admin', { input: INPUT });
      expect(result.errors?.[0]?.message, document).toContain('clientSecret');
    }
    const listed = await ok<{ oauthProviders: Record<string, unknown>[] }>(
      '{ oauthProviders { id clientId hasClientSecret } }',
    );
    expect(listed.oauthProviders).toEqual([
      { id: provider.id, clientId: '••••oard', hasClientSecret: true },
    ]);
  });

  it('refuses a body missing a required field, storing nothing', async () => {
    const result = await run(
      'mutation ($input: JSON!) { createOAuthProvider(input: $input) { id } }',
      'admin',
      { input: { name: 'Keycloak', clientId: 'cpm' } },
    );
    expect(result.errors?.[0]?.message).toBe('clientSecret is required');
    expect(await ctx.db.select().from(db.oauthProviders)).toEqual([]);
  });

  it('updates one, keeping the secret when the body leaves it blank', async () => {
    const existing = await createOAuthProvider({ ...INPUT, source: 'ui' });
    const data = await ok<{ updateOAuthProvider: Record<string, unknown> }>(
      'mutation ($id: String!, $input: JSON!) { updateOAuthProvider(id: $id, input: $input) { name enabled hasClientSecret } }',
      { id: existing.id, input: { name: 'Keycloak (staff)', enabled: false, clientSecret: '' } },
    );
    expect(data.updateOAuthProvider).toEqual({
      name: 'Keycloak (staff)',
      enabled: false,
      hasClientSecret: true,
    });
    const [row] = await ctx.db
      .select()
      .from(db.oauthProviders)
      .where(eq(db.oauthProviders.id, existing.id));
    expect(row).toMatchObject({ name: 'Keycloak (staff)', enabled: false });
    expect(invalidateProviderCache).toHaveBeenCalledTimes(1);
  });

  it('lets an env-sourced provider be switched, and nothing else', async () => {
    const fromEnv = await createOAuthProvider({ ...INPUT, name: 'From env', source: 'env' });
    const renamed = await run(
      'mutation ($id: String!) { updateOAuthProvider(id: $id, input: { name: "Other" }) { id } }',
      'admin',
      { id: fromEnv.id },
    );
    expect(renamed.errors?.[0]?.message).toBe(
      'Environment-sourced providers can only update: enabled',
    );
    const switched = await ok<{ updateOAuthProvider: { enabled: boolean } }>(
      'mutation ($id: String!) { updateOAuthProvider(id: $id, input: { enabled: false }) { enabled } }',
      { id: fromEnv.id },
    );
    expect(switched.updateOAuthProvider.enabled).toBe(false);

    const deleted = await run('mutation ($id: String!) { deleteOAuthProvider(id: $id) }', 'admin', {
      id: fromEnv.id,
    });
    expect(deleted.errors?.[0]?.message).toBe(
      'Cannot delete an environment-sourced OAuth provider',
    );
    expect(await ctx.db.select().from(db.oauthProviders)).toHaveLength(1);
  });

  it('deletes one made here, and answers not found for an id it does not know', async () => {
    const existing = await createOAuthProvider({ ...INPUT, source: 'ui' });
    await ok('mutation ($id: String!) { deleteOAuthProvider(id: $id) }', { id: existing.id });
    expect(await ctx.db.select().from(db.oauthProviders)).toEqual([]);
    expect(invalidateProviderCache).toHaveBeenCalledTimes(1);

    for (const document of [
      'mutation { deleteOAuthProvider(id: "missing") }',
      'mutation { updateOAuthProvider(id: "missing", input: { enabled: true }) { id } }',
    ]) {
      const result = await run(document);
      expect(result.errors?.[0]?.message, document).toBe('OAuth provider not found');
    }
  });
});
