/**
 * Access lists over GraphQL: rules with geo targets and expiry, the deny response, fail closed and
 * the stats. Admin only, like the REST routes.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
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

beforeEach(async () => {
  ctx.db = await createTestDb();
  installFakeCaddy();
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

const FIELDS = `id rules { action cidr country continent asn note expiresAt }
  ipDefault satisfy passAuth failClosed denyResponse { status body redirectUrl }`;

describe('access lists', () => {
  it('replaces the rules, sets the deny response, and reads them back', async () => {
    const created = await ok<{ createAccessList: { id: number; denyResponse: unknown } }>(
      `mutation($input: JSON!) { createAccessList(input: $input) { ${FIELDS} } }`,
      {
        input: {
          name: 'travel',
          denyResponse: { status: 451, body: 'Not here' },
          failClosed: true,
        },
      },
    );
    const id = created.createAccessList.id;
    expect(created.createAccessList.denyResponse).toEqual({
      status: 451,
      body: 'Not here',
      redirectUrl: null,
    });

    const set = await ok<{ setAccessListRules: { rules: unknown[]; failClosed: boolean } }>(
      `mutation($id: Int!, $rules: JSON!) { setAccessListRules(id: $id, rules: $rules) { ${FIELDS} } }`,
      {
        id,
        rules: [
          { action: 'deny', cidr: '192.0.2.7' },
          { action: 'allow', country: 'PT', note: 'Offsite', expiresAt: '2099-01-01T00:00:00Z' },
          { action: 'deny', asn: 4_200_000_000 },
        ],
      },
    );
    expect(set.setAccessListRules.failClosed).toBe(true);
    expect(set.setAccessListRules.rules).toEqual([
      {
        action: 'deny',
        cidr: '192.0.2.7/32',
        country: null,
        continent: null,
        asn: null,
        note: null,
        expiresAt: null,
      },
      {
        action: 'allow',
        cidr: null,
        country: 'PT',
        continent: null,
        asn: null,
        note: 'Offsite',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      {
        action: 'deny',
        cidr: null,
        country: null,
        continent: null,
        asn: 4_200_000_000,
        note: null,
        expiresAt: null,
      },
    ]);

    const cleared = await ok<{ updateAccessList: { denyResponse: unknown } }>(
      `mutation($id: Int!) { updateAccessList(id: $id, input: { denyResponse: null }) { ${FIELDS} } }`,
      { id },
    );
    expect(cleared.updateAccessList.denyResponse).toBeNull();
  });

  it('answers the stats, without traffic while analytics are off', async () => {
    const created = await ok<{ createAccessList: { id: number } }>(
      `mutation { createAccessList(input: { name: "office" }) { id } }`,
    );
    const stats = await ok<{ accessListStats: unknown }>(
      `query($id: Int!) { accessListStats(id: $id) { hosts stopped failedSignIns } }`,
      { id: created.createAccessList.id },
    );
    expect(stats.accessListStats).toEqual({ hosts: 0, stopped: null, failedSignIns: null });
    expect((await run(`query { accessListStats(id: 999) { hosts } }`)).errors).toBeDefined();
  });

  it('refuses a non-admin', async () => {
    for (const document of [
      `query { accessListStats(id: 1) { hosts } }`,
      `mutation { setAccessListRules(id: 1, rules: []) { id } }`,
    ]) {
      expect((await run(document, 'operator')).errors?.length).toBeGreaterThan(0);
    }
  });
});
