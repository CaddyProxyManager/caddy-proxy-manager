/**
 * The security resources over GraphQL: WAF exclusions, the deny list and the security report.
 * Writes are read back from the database, and every field refuses a non-admin.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import * as db from '../../../src/lib/db/schema';
import { type CaddyValidator, setCaddyValidator } from '../../../src/lib/waf/dry-run';
import { installFakeCaddy } from '../../helpers/caddy-admin';

const NOW = '2026-03-01T00:00:00.000Z';

function contextFor(role: string): GraphQLContext {
  return {
    viewer: async () => ({ userId: 1, role, authMethod: 'bearer' as const }),
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

async function run(document: string, role = 'admin', variableValues?: Record<string, unknown>) {
  return graphql({ schema, source: document, contextValue: contextFor(role), variableValues });
}

async function ok<T = Record<string, unknown>>(document: string, vars?: Record<string, unknown>) {
  const result = await run(document, 'admin', vars);
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

let restore: CaddyValidator | null = null;

beforeEach(async () => {
  ctx.db = await createTestDb();
  installFakeCaddy();
  // No agent can validate here: the save proceeds, as it does on a stack without one.
  restore = setCaddyValidator(async () => null);
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

afterEach(() => {
  if (restore) setCaddyValidator(restore);
  restore = null;
});

describe('WAF exclusions', () => {
  it('creates, lists, updates and deletes one', async () => {
    const created = await ok<{ createWafExclusion: { id: number; path: string } }>(
      `mutation($input: WafExclusionInput!) { createWafExclusion(input: $input) { id path } }`,
      { input: { ruleId: 942100, path: '/upload/', reason: 'editor' } },
    );
    expect(created.createWafExclusion.path).toBe('/upload/');

    const listed = await ok<{ wafExclusions: { ruleId: number; reason: string }[] }>(
      '{ wafExclusions { ruleId reason } }',
    );
    expect(listed.wafExclusions).toEqual([{ ruleId: 942100, reason: 'editor' }]);

    await ok(
      `mutation($id: Int!, $input: WafExclusionInput!) { updateWafExclusion(id: $id, input: $input) { id } }`,
      { id: created.createWafExclusion.id, input: { ruleId: 942100, target: 'ARGS:body' } },
    );
    const [stored] = await ctx.db.select().from(db.wafExclusions);
    expect(stored).toMatchObject({ path: null, target: 'ARGS:body' });

    await ok(`mutation($id: Int!) { deleteWafExclusion(id: $id) }`, {
      id: created.createWafExclusion.id,
    });
    expect(await ctx.db.select().from(db.wafExclusions)).toEqual([]);
  });

  it("answers the model's refusal of a protected rule", async () => {
    const result = await run(`mutation { createWafExclusion(input: { ruleId: 949110 }) { id } }`);
    expect(result.errors?.[0]?.message).toContain('949110');
  });
});

describe('blocked sources', () => {
  it('blocks and unblocks a source', async () => {
    const created = await ok<{ createBlockedSource: { id: number; value: string } }>(
      `mutation { createBlockedSource(input: { kind: "asn", value: "AS64500", reason: "spam" }) { id value } }`,
    );
    expect(created.createBlockedSource.value).toBe('64500');
    expect(
      (await ok<{ blockedSources: unknown[] }>('{ blockedSources { kind value } }')).blockedSources,
    ).toEqual([{ kind: 'asn', value: '64500' }]);
    await ok(`mutation($id: Int!) { deleteBlockedSource(id: $id) }`, {
      id: created.createBlockedSource.id,
    });
    expect(await ctx.db.select().from(db.blockedSources)).toEqual([]);
  });
});

describe('security report', () => {
  it('shows the rule set alone with analytics off', async () => {
    const data = await ok<{ securityReport: { source: string; ruleSet: { exclusions: number } } }>(
      '{ securityReport(query: { range: "24h" }) { source ruleSet } }',
    );
    expect(data.securityReport.source).toBe('none');
    expect(data.securityReport.ruleSet.exclusions).toBe(0);
  });
});

describe('a non-administrator', () => {
  it('is refused every security field, and nothing is written', async () => {
    for (const document of [
      '{ wafExclusions { id } }',
      '{ blockedSources { id } }',
      '{ securityReport { source } }',
      '{ wafEvent(key: "1.0123456789abcdef0123") { curl } }',
      'mutation { createBlockedSource(input: { kind: "ip", value: "203.0.113.7" }) { id } }',
      'mutation { createWafExclusion(input: { ruleId: 942100 }) { id } }',
      'mutation { reviewWafEvent(key: "1.0123456789abcdef0123", verdict: "intended") { verdict } }',
    ]) {
      const result = await run(document, 'user');
      expect(result.errors?.[0]?.message).toContain('Administrator');
    }
    expect(await ctx.db.select().from(db.blockedSources)).toEqual([]);
    expect(await ctx.db.select().from(db.wafExclusions)).toEqual([]);
    expect(await ctx.db.select().from(db.wafEventReviews)).toEqual([]);
  });
});
