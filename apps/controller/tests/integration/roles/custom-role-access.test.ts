/**
 * What a made role gives, alone or carried by a group, and that a token narrows it and never
 * widens it: over GraphQL as served, every field passes only where both the role and the scope do.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import type { GraphQLFieldResolver } from 'graphql';
import { schema as servedSchema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { ApiAuthError, ROLE_REFUSED, TOKEN_SCOPE_REFUSED } from '../../../src/lib/api/auth';
import { type TokenScope, parseTokenScope } from '../../../src/lib/api-tokens/scope';
import { GRAPHQL_REQUIREMENTS, tokenAllows } from '../../../src/lib/api-tokens/requirements';
import { BUILT_IN_ROLES } from '../../../src/lib/roles/built-in';
import { capabilitySetOf } from '../../../src/lib/roles/capabilities';
import { createRole } from '../../../src/lib/roles/store';
import { setGroupGrants } from '../../../src/lib/models/group-grants';
import { setGroupRole } from '../../../src/lib/models/groups';
import type { DomainError } from '../../../src/lib/errors/domain-error';
import {
  accessFor,
  can,
  canCreate,
  canReach,
  canView,
  resolveAccess,
} from '../../../src/lib/users/permissions';
import * as schema from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();
const ADMIN = { userId: 1, role: 'admin', capabilities: capabilitySetOf([BUILT_IN_ROLES.admin]) };
const USER_ID = 5;

async function seedUser(role: string): Promise<void> {
  await ctx.db.insert(schema.users).values({
    id: USER_ID,
    email: 'someone@example.com',
    role,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedGroup(id: number, role: string | null = null, members = [USER_ID]) {
  await ctx.db
    .insert(schema.groups)
    .values({ id, name: `g${id}`, role, createdAt: NOW, updatedAt: NOW });
  for (const userId of members) {
    await ctx.db.insert(schema.groupMembers).values({ groupId: id, userId, createdAt: NOW });
  }
}

beforeEach(async () => {
  await ctx.db.delete(schema.groupGrants);
  await ctx.db.delete(schema.groupMembers);
  await ctx.db.delete(schema.groups);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.delete(schema.roles);
  await ctx.db.insert(schema.proxyHosts).values(
    [1, 2].map((id) => ({
      id,
      name: `h${id}`,
      domains: `["h${id}.example.com"]`,
      upstreams: '["a:80"]',
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
});

describe('a made role', () => {
  it('holds exactly its capabilities', async () => {
    const role = await createRole({ name: 'Auditors', capabilities: ['audit:read'] }, ADMIN);
    await seedUser(role.key);
    const access = await accessFor(USER_ID, role.key);
    expect(can(access, 'audit:read')).toBe(true);
    expect(can(access, 'audit:write')).toBe(false);
    expect(can(access, 'settings:read')).toBe(false);
  });

  it('scoped, reaches hosts only through grants, and creates none', async () => {
    const role = await createRole(
      { name: 'Host team', capabilities: ['hosts:write'], scoped: true },
      ADMIN,
    );
    await seedUser(role.key);
    await seedGroup(1);
    await setGroupGrants(1, [{ resource: { kind: 'proxyHost', id: 1 }, capability: 'manage' }]);
    const access = await accessFor(USER_ID, role.key);
    expect(canView(access, 'proxyHost', 1)).toBe(true);
    expect(canView(access, 'proxyHost', 2)).toBe(false);
    expect(canReach(access, 'hosts:read')).toBe(true);
    expect(canCreate(access, 'proxyHost')).toBe(false);
  });

  it('unscoped, reaches every host and creates them', async () => {
    const role = await createRole({ name: 'Hosts', capabilities: ['hosts:write'] }, ADMIN);
    await seedUser(role.key);
    const access = await accessFor(USER_ID, role.key);
    expect(canView(access, 'proxyHost', 2)).toBe(true);
    expect(canCreate(access, 'proxyHost')).toBe(true);
  });

  it('that was deleted holds nothing', async () => {
    await seedUser('role-0123456789ab');
    expect((await accessFor(USER_ID, 'role-0123456789ab')).capabilities).toEqual({});
  });
});

describe('a group carrying a role', () => {
  it('adds it to every member, beside their own', async () => {
    const role = await createRole({ name: 'Auditors', capabilities: ['audit:read'] }, ADMIN);
    await seedUser('viewer');
    await seedGroup(1, role.key);
    expect(can(await accessFor(USER_ID, 'viewer'), 'audit:read')).toBe(true);
  });

  it('reaches only through the grants of the member groups', async () => {
    await seedUser('viewer');
    await seedGroup(1, 'operator');
    await seedGroup(2, null);
    await setGroupGrants(2, [{ resource: { kind: 'proxyHost', id: 2 }, capability: 'view' }]);
    const access = await accessFor(USER_ID, 'viewer');
    expect(canView(access, 'proxyHost', 2)).toBe(true);
    expect(canView(access, 'proxyHost', 1)).toBe(false);
  });

  it('carries over into view-as for the groups chosen', async () => {
    const role = await createRole({ name: 'Auditors', capabilities: ['audit:read'] }, ADMIN);
    await seedUser('admin');
    await seedGroup(1, role.key, []);
    const access = await resolveAccess({
      user: { id: String(USER_ID), email: 'someone@example.com', name: null, role: 'viewer' },
      viewAs: { role: 'viewer', groupIds: [1], expiresAt: '' },
      realRole: 'admin',
    });
    expect(can(access, 'audit:read')).toBe(true);
    expect(can(access, 'audit:write')).toBe(false);
  });

  it('is set only to a role the actor holds, and never to admin', async () => {
    await seedGroup(1, null, []);
    const refuse = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (error) {
        return (error as DomainError).code;
      }
      return 'allowed';
    };
    expect(await refuse(setGroupRole(1, 'admin', ADMIN))).toBe('groupRoleAdmin');
    const users = capabilitySetOf([{ key: 'u', capabilities: ['groups:write'], scoped: false }]);
    expect(await refuse(setGroupRole(1, 'operator', { userId: 2, capabilities: users }))).toBe(
      'roleExceedsYours',
    );
    expect((await setGroupRole(1, 'operator', ADMIN)).role).toBe('operator');
    // Taking away a role the actor could not have given is acting above them too.
    expect(await refuse(setGroupRole(1, null, { userId: 2, capabilities: users }))).toBe(
      'roleExceedsYours',
    );
    expect((await setGroupRole(1, null, ADMIN)).role).toBeNull();
  });
});

describe('a token', () => {
  function fields(): Array<['Query' | 'Mutation', string]> {
    return Object.keys(GRAPHQL_REQUIREMENTS).map(
      (key) => key.split('.') as ['Query' | 'Mutation', string],
    );
  }

  /** Refused by the wrapper, with which of the two said no; null when both let it through. */
  async function refusal(
    type: 'Query' | 'Mutation',
    field: string,
    role: string,
    tokenScope: TokenScope,
  ): Promise<string | null> {
    const object = type === 'Query' ? servedSchema.getQueryType() : servedSchema.getMutationType();
    const resolve = object?.getFields()[field]?.resolve as GraphQLFieldResolver<
      unknown,
      GraphQLContext
    >;
    const context: GraphQLContext = {
      viewer: async () => ({ userId: USER_ID, role, authMethod: 'bearer', tokenScope }),
      access: () => accessFor(USER_ID, role),
      rawBody: async () => '',
      request: {} as never,
    };
    try {
      await Promise.race([
        resolve(undefined, {}, context, {} as never),
        new Promise((done) => setTimeout(done, 1000)),
      ]);
    } catch (error) {
      // Only the wrapper's two refusals: what a resolver says past them is not this test's.
      if (
        error instanceof ApiAuthError &&
        [ROLE_REFUSED, TOKEN_SCOPE_REFUSED].includes(error.message)
      ) {
        return error.message;
      }
    }
    return null;
  }

  it("never does more than its owner's made role, nor more than its own scope", async () => {
    const role = await createRole(
      { name: 'Readers', capabilities: ['hosts:read', 'audit:read', 'settings:read'] },
      ADMIN,
    );
    await seedUser(role.key);
    const scope = parseTokenScope('custom', ['hosts:write', 'audit:read']);
    const owner = await accessFor(USER_ID, role.key);
    for (const [type, field] of fields()) {
      const requirement = GRAPHQL_REQUIREMENTS[`${type}.${field}`];
      const byRole = requirement.signedIn === true || can(owner, requirement.capability);
      const byToken = tokenAllows(scope, requirement);
      const answer = await refusal(type, field, role.key, scope);
      const expected = !byToken ? TOKEN_SCOPE_REFUSED : !byRole ? ROLE_REFUSED : null;
      expect({ field: `${type}.${field}`, answer }).toEqual({
        field: `${type}.${field}`,
        answer: expected,
      });
    }
  }, 60_000);
});
