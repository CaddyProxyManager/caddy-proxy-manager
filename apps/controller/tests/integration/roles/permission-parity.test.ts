/**
 * Every decision the four built-in roles get, written down once in `__golden__` before any check
 * moved onto capabilities, and recomputed here from the code as it is now. A refactor of the
 * permission model is only a refactor while this passes. `UPDATE_GOLDEN=1` rewrites the file,
 * which is for adding a dimension, never for making a red run green.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import type { GraphQLFieldResolver } from 'graphql';
import { schema as servedSchema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { ApiAuthError } from '../../../src/lib/api/auth';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { type TokenScope, parseTokenScope } from '../../../src/lib/api-tokens/scope';
import { restRequirement, roleAllows, tokenAllows } from '../../../src/lib/api-tokens/requirements';
import { setGroupGrants, type GrantCapability } from '../../../src/lib/models/group-grants';
import { collectAttention } from '../../../src/lib/attention';
import type { AttentionItem } from '../../../src/lib/attention/types';
import { DESTINATIONS, visibleDestinations } from '../../../src/lib/nav/destinations';
import { readViewAs, VIEW_AS_ROLES } from '../../../src/lib/users/view-as';
import * as permissions from '../../../src/lib/users/permissions';
import * as dbSchema from '../../../src/lib/db/schema';
import { restHandlers } from '../../helpers/entry-points';
import { capabilitiesOf } from '../../helpers/access';
import {
  CAPABILITIES,
  type Capability,
  objectKindsOf,
  splitCapability,
} from '../../../src/lib/roles/capabilities';

const GOLDEN = join(import.meta.dir, '__golden__', 'permission-parity.json');

const ROLES = ['admin', 'operator', 'user', 'viewer'] as const;
type Role = (typeof ROLES)[number];
const GRANTS = ['none', 'view', 'manage'] as const;
type Grant = (typeof GRANTS)[number];

/** One user per role, all in one group whose grants the case sets. */
const USER_ID: Record<Role, number> = { admin: 1, operator: 2, user: 3, viewer: 4 };
const GROUP_ID = 1;
const KINDS = ['proxyHost', 'l4ProxyHost', 'agent'] as const;
type Kind = (typeof KINDS)[number];

/**
 * `-` is the capability over every object (or none: creating, settings), `*` is holding it over at
 * least one, which opens a list page whose rows are then filtered, and `<kind>:1` is one object.
 */
function objectsFor(capability: Capability): string[] {
  const kinds = objectKindsOf(splitCapability(capability)[0]);
  return ['-', '*', ...kinds.map((kind) => `${kind}:1`)];
}

type Access = Awaited<ReturnType<typeof permissions.accessFor>>;

// ── The decisions, from the code as it is ─────────────────────────────────────────────────────

function capabilityDecision(access: Access, capability: Capability, object: string): boolean {
  if (object === '-') return permissions.can(access, capability);
  if (object === '*') return permissions.canReach(access, capability);
  const [kind, id] = object.split(':');
  return permissions.can(access, capability, { kind: kind as Kind, id: Number(id) });
}

function navFor(role: Role): string[] {
  return visibleDestinations(capabilitiesOf(role)).map((destination) => destination.id);
}

function attentionItem(id: string, scope: AttentionItem['scope']): AttentionItem {
  return {
    id,
    provider: 'certificates',
    code: 'certificateExpiring',
    severity: 'warning',
    values: {},
    href: null,
    at: null,
    scope,
  };
}

async function attentionFor(access: Access): Promise<string[]> {
  const items = [
    attentionItem('host:1', { proxyHosts: [1] }),
    attentionItem('host:2', { proxyHosts: [2] }),
    attentionItem('agent:1', { agent: 1 }),
    attentionItem('instance', {}),
  ];
  const list = await collectAttention(access, {
    providers: [
      { id: 'certificates', adminOnly: false, run: async () => ({ items }) },
      {
        id: 'backups',
        adminOnly: true,
        run: async () => ({ items: [attentionItem('admin-only:1', { proxyHosts: [1] })] }),
      },
    ],
  });
  return list.items.map((item) => item.id).sort();
}

// ── Seeding ────────────────────────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  await ctx.db.delete(dbSchema.groupGrants);
  await ctx.db.delete(dbSchema.groupMembers);
  await ctx.db.delete(dbSchema.groups);
  await ctx.db.delete(dbSchema.proxyHosts);
  await ctx.db.delete(dbSchema.l4ProxyHosts);
  await ctx.db.delete(dbSchema.agents);
  await ctx.db.delete(dbSchema.users).catch(() => {});
  await ctx.db.insert(dbSchema.users).values(
    ROLES.map((role) => ({
      id: USER_ID[role],
      email: `${role}@example.com`,
      name: role,
      role,
      provider: 'credentials',
      subject: role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })),
  );
  await ctx.db.insert(dbSchema.proxyHosts).values(
    [1, 2].map((id) => ({
      id,
      name: `host-${id}`,
      domains: `["h${id}.example.com"]`,
      upstreams: '["app:80"]',
      createdAt: now,
      updatedAt: now,
    })),
  );
  await ctx.db.insert(dbSchema.l4ProxyHosts).values(
    [1, 2].map((id) => ({
      id,
      name: `l4-${id}`,
      protocol: 'tcp',
      listenAddress: `:${5000 + id}`,
      upstreams: '["db:5432"]',
      createdAt: now,
      updatedAt: now,
    })),
  );
  await ctx.db.insert(dbSchema.agents).values(
    [1, 2].map((id) => ({
      id,
      name: `agent-${id}`,
      agentId: String(id).repeat(32),
      secret: 'x',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await ctx.db.insert(dbSchema.groups).values({
    id: GROUP_ID,
    name: 'Everyone',
    description: null,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db
    .insert(dbSchema.groupMembers)
    .values(ROLES.map((role) => ({ groupId: GROUP_ID, userId: USER_ID[role], createdAt: now })));
}

async function grant(level: Grant): Promise<void> {
  const capability = level as GrantCapability;
  await setGroupGrants(
    GROUP_ID,
    level === 'none' ? [] : KINDS.map((kind) => ({ resource: { kind, id: 1 }, capability })),
  );
}

// ── GraphQL, as served ─────────────────────────────────────────────────────────────────────────

function isRefusal(error: unknown): boolean {
  if (error instanceof ApiAuthError) return error.status === 403 || error.status === 401;
  return (
    error instanceof DomainError &&
    (error.code === 'accessDenied' || error.code === 'adminRequired')
  );
}

/** Whether a field's resolver gets past its checks; what it does after is not this test's. */
async function graphqlAllowed(
  type: 'Query' | 'Mutation',
  field: string,
  role: Role,
  tokenScope?: TokenScope,
): Promise<boolean> {
  const object = type === 'Query' ? servedSchema.getQueryType() : servedSchema.getMutationType();
  const resolve = object?.getFields()[field]?.resolve as GraphQLFieldResolver<
    unknown,
    GraphQLContext
  >;
  const context: GraphQLContext = {
    viewer: async () => ({
      userId: USER_ID[role],
      role,
      authMethod: tokenScope ? 'bearer' : 'session',
      tokenScope,
    }),
    access: () => permissions.accessFor(USER_ID[role], role),
    rawBody: async () => '',
    request: {} as never,
  };
  try {
    await Promise.race([
      resolve(undefined, {}, context, {} as never),
      new Promise((done) => setTimeout(done, 2000)),
    ]);
    return true;
  } catch (error) {
    return !isRefusal(error);
  }
}

/** The agent's own fields authenticate as an agent and never reach a role. */
const AGENT_FIELDS = new Set([
  'agentStatus',
  'agentCommandResults',
  'agentAnalytics',
  'agentCertificateFiles',
]);

function graphqlFields(): Array<['Query' | 'Mutation', string]> {
  const names = (type: 'Query' | 'Mutation') =>
    Object.keys(
      (type === 'Query'
        ? servedSchema.getQueryType()
        : servedSchema.getMutationType()
      )?.getFields() ?? {},
    )
      .filter((name) => !AGENT_FIELDS.has(name))
      .sort()
      .map((name): ['Query' | 'Mutation', string] => [type, name]);
  return [...names('Query'), ...names('Mutation')];
}

const TOKEN_SCOPES: Record<string, TokenScope | undefined> = {
  session: undefined,
  full: { kind: 'full' },
  read: { kind: 'read' },
  hostsRead: parseTokenScope('custom', ['hosts:read']),
  settingsWrite: parseTokenScope('custom', ['settings:write']),
  usersWrite: parseTokenScope('custom', ['users:write']),
};

// ── REST ───────────────────────────────────────────────────────────────────────────────────────

/** Every handler that takes the API's authentication goes through `requireApiUser`. */
function takesApiAuth(body: string): boolean {
  return /\brequireApiUser\(/.test(body);
}

/** As `requireApiUser` decides it: the role by the path's requirement, then the token's scope. */
function restRoleAllows(path: string, access: Access): boolean {
  const [method, pathname] = path.split(' ');
  return roleAllows(
    (capability) => permissions.can(access, capability),
    restRequirement(pathname, method),
  );
}

async function restDecisions(): Promise<Record<string, Record<string, string[]>>> {
  const handlers = restHandlers()
    .map((handler) => ({ handler, path: handler.id.replace(/\[[^\]]+\]/g, '1') }))
    .filter(({ handler }) => takesApiAuth(handler.body))
    .sort((a, b) => a.handler.id.localeCompare(b.handler.id));
  const byRole: Record<string, string[]> = {};
  for (const role of ROLES) {
    const access = await permissions.accessFor(USER_ID[role], role);
    byRole[role] = handlers
      .filter(({ path }) => restRoleAllows(path, access))
      .map(({ handler }) => handler.id);
  }
  const byScope: Record<string, string[]> = {};
  for (const [name, scope] of Object.entries(TOKEN_SCOPES)) {
    byScope[name] = handlers
      .filter(({ path }) => {
        const [method, pathname] = path.split(' ');
        return tokenAllows(scope, restRequirement(pathname, method));
      })
      .map(({ handler }) => handler.id);
  }
  return { roles: byRole, adminTokens: byScope };
}

// ── All of it ──────────────────────────────────────────────────────────────────────────────────

async function decide() {
  await seed();
  const capabilities: Record<string, Record<string, Record<string, boolean>>> = {};
  const visible: Record<string, Record<string, unknown>> = {};
  const attention: Record<string, string[]> = {};
  for (const level of GRANTS) {
    await grant(level);
    for (const role of ROLES) {
      const access = await permissions.accessFor(USER_ID[role], role);
      const key = `${role}/${level}`;
      capabilities[key] = {};
      for (const capability of CAPABILITIES) {
        capabilities[key][capability] = Object.fromEntries(
          objectsFor(capability).map((object) => [
            object,
            capabilityDecision(access, capability, object),
          ]),
        );
      }
      visible[key] = Object.fromEntries(
        KINDS.map((kind) => {
          const filter = permissions.visibleIdFilter(access, kind);
          return [
            kind,
            {
              ids: permissions.visibleIds(access, kind, [1, 2]),
              filter: filter === null ? null : [...filter].sort(),
            },
          ];
        }),
      );
      attention[key] = await attentionFor(access);
    }
  }

  // An administrator viewing as a role and the group, which is not one of the admin's.
  await grant('manage');
  await ctx.db.delete(dbSchema.groupMembers);
  const viewAs: Record<string, unknown> = {};
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  for (const realRole of ROLES) {
    for (const viewRole of [...VIEW_AS_ROLES, 'admin']) {
      const view = readViewAs(
        { viewAsRole: viewRole, viewAsGroupIds: '[1]', viewAsExpiresAt: expiresAt },
        realRole,
      );
      viewAs[`${realRole}->${viewRole}`] = view?.role ?? null;
    }
  }
  for (const viewRole of VIEW_AS_ROLES) {
    for (const groupIds of [[], [GROUP_ID]]) {
      const access = await permissions.resolveAccess({
        user: { id: '1', email: 'admin@example.com', name: null, role: viewRole },
        viewAs: { role: viewRole, groupIds, expiresAt },
        realRole: 'admin',
      });
      viewAs[`access:${viewRole}/${groupIds.length ? 'group' : 'none'}`] = Object.fromEntries(
        CAPABILITIES.filter(
          (capability) => objectKindsOf(splitCapability(capability)[0]).length,
        ).map((capability) => [
          capability,
          Object.fromEntries(
            objectsFor(capability).map((object) => [
              object,
              capabilityDecision(access, capability, object),
            ]),
          ),
        ]),
      );
    }
  }
  await seed();

  const nav = Object.fromEntries(ROLES.map((role) => [role, navFor(role)]));

  const graphql: Record<string, string[]> = {};
  for (const role of ROLES) {
    const allowed: string[] = [];
    for (const [type, field] of graphqlFields()) {
      if (await graphqlAllowed(type, field, role)) allowed.push(`${type}.${field}`);
    }
    graphql[role] = allowed;
  }
  const graphqlTokens: Record<string, string[]> = {};
  for (const [name, scope] of Object.entries(TOKEN_SCOPES)) {
    const allowed: string[] = [];
    for (const [type, field] of graphqlFields()) {
      if (await graphqlAllowed(type, field, 'admin', scope)) allowed.push(`${type}.${field}`);
    }
    graphqlTokens[name] = allowed;
  }

  return {
    destinations: DESTINATIONS.map((destination) => destination.id),
    capabilities,
    visible,
    attention,
    viewAs,
    nav,
    graphql: { roles: graphql, adminTokens: graphqlTokens },
    rest: await restDecisions(),
  };
}

/**
 * Own tokens, a reviewer's own access review items, and change requests, whose approvers the
 * policy names: none needs a capability, and each resolver narrows to the caller's own.
 */
const GRAPHQL_SIGNED_IN_ONLY = [
  'Query.apiTokens',
  'Query.accessReviews',
  'Query.accessReview',
  'Query.changeRequests',
  'Query.changeRequest',
  'Mutation.createApiToken',
  'Mutation.deleteApiToken',
  'Mutation.decideAccessReviewItem',
  'Mutation.approveChangeRequest',
  'Mutation.rejectChangeRequest',
  'Mutation.withdrawChangeRequest',
  'Mutation.bypassChangeRequest',
  // Own sessions: any signed-in role may list and revoke its own.
  'Query.sessions',
  'Mutation.revokeSession',
];

describe('every GraphQL resolver', () => {
  it('refuses a role without permissions, except on its own things', async () => {
    await seed();
    const open: string[] = [];
    for (const [type, field] of graphqlFields()) {
      if (await graphqlAllowed(type, field, 'viewer')) open.push(`${type}.${field}`);
    }
    expect(open.sort()).toEqual([...GRAPHQL_SIGNED_IN_ONLY].sort());
  }, 60_000);
});

describe('the built-in roles', () => {
  it('decide exactly as the golden file records', async () => {
    const decisions = JSON.parse(JSON.stringify(await decide()));
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(join(import.meta.dir, '__golden__'), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(decisions, null, 2)}\n`);
    }
    expect(decisions).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  }, 120_000);
});
