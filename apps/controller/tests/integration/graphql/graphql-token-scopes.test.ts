/**
 * The schema as served wraps every Query and Mutation in the token-scope check. Effective access is
 * the owner's role and the scope together: neither alone opens anything.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { type TokenScope, parseTokenScope } from '../../../src/lib/api-tokens/scope';
import { createApiToken, listApiTokens } from '../../../src/lib/models/api-tokens';
import * as dbSchema from '../../../src/lib/db/schema';

function contextFor(role: string, tokenScope?: TokenScope): GraphQLContext {
  return {
    viewer: async () => ({
      userId: 1,
      role,
      authMethod: tokenScope ? 'bearer' : 'session',
      tokenScope,
    }),
    access: async () => ({
      userId: 1,
      role,
      isAdmin: role === 'admin',
      isOperator: role === 'operator',
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(source: string, role: string, tokenScope?: TokenScope) {
  const result = await graphql({ schema, source, contextValue: contextFor(role, tokenScope) });
  return { data: result.data, errors: result.errors?.map((error) => error.message) ?? [] };
}

const REFUSED = "This API token's scope does not allow this request";
const CREATE_LIST = 'mutation { createAccessList(input: { name: "office" }) { id } }';

beforeEach(async () => {
  await ctx.db.delete(dbSchema.apiTokens).catch(() => {});
  await ctx.db.delete(dbSchema.accessLists).catch(() => {});
  await ctx.db.delete(dbSchema.users).catch(() => {});
  await ctx.db.insert(dbSchema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('a read-only token', () => {
  it('reads what its owner can read', async () => {
    const result = await run('{ proxyHosts { id } accessLists { id } }', 'admin', {
      kind: 'read',
    });
    expect(result.errors).toEqual([]);
  });

  it('is refused every mutation, the audit check and the config export included', async () => {
    for (const source of [
      CREATE_LIST,
      'mutation { verifyAuditChain { ok } }',
      'mutation { exportConfig(passphrase: "a long passphrase here") }',
    ]) {
      expect((await run(source, 'admin', { kind: 'read' })).errors).toEqual([REFUSED]);
    }
  });
});

describe('a custom token', () => {
  const scope = parseTokenScope('custom', ['accessLists:write']);

  it('does what it lists and nothing else', async () => {
    expect((await run(CREATE_LIST, 'admin', scope)).errors).toEqual([]);
    expect((await run('{ proxyHosts { id } }', 'admin', scope)).errors).toEqual([REFUSED]);
  });

  it('still needs the role: a user is refused what the scope names', async () => {
    const result = await run(CREATE_LIST, 'user', scope);
    expect(result.errors).toEqual(['Administrator privileges required']);
  });
});

describe('a session', () => {
  it('is limited by its role alone', async () => {
    expect((await run(CREATE_LIST, 'admin')).errors).toEqual([]);
  });
});

describe('a token as listed', () => {
  it('reports its scope and permissions', async () => {
    await createApiToken('ci', 1, undefined, parseTokenScope('custom', ['hosts:read']));
    await createApiToken('legacy', 1);
    const result = await run('{ apiTokens { name scope permissions } }', 'admin');
    expect(result.errors).toEqual([]);
    const tokens = (result.data as { apiTokens: Array<Record<string, unknown>> }).apiTokens;
    expect(tokens).toContainEqual({ name: 'ci', scope: 'custom', permissions: ['hosts:read'] });
    expect(tokens).toContainEqual({ name: 'legacy', scope: 'full', permissions: [] });
    expect((await listApiTokens(1)).length).toBe(2);
  });
});
