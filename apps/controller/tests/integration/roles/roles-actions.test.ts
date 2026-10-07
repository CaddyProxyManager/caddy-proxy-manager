/**
 * The Roles page, the group role and the user role as their actions and GraphQL run them, for an
 * administrator and for a made role that manages users and groups but holds nothing else: it may
 * hand out what it holds, and nothing that would lift anyone, itself included, above it.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  session: null as null | { user: { id: string; email: string; name: string; role: string } },
}));

ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  auth: vi.fn(async () => ctx.session),
}));

import { graphql } from 'graphql';
import { schema as servedSchema } from '@/src/lib/graphql/schema';
import type { GraphQLContext } from '@/src/lib/graphql/context';
import { deleteRoleAction, saveRoleAction } from '@/src/app/(dashboard)/users/roles/actions';
import {
  addGroupMemberAction,
  setGroupGrantsAction,
  setGroupRoleAction,
} from '@/src/app/(dashboard)/groups/actions';
import { updateUserRoleAction, updateUserStatusAction } from '@/src/app/(dashboard)/users/actions';
import { BUILT_IN_ROLES } from '@/src/lib/roles/built-in';
import { capabilitySetOf } from '@/src/lib/roles/capabilities';
import { createRole } from '@/src/lib/roles/store';
import { accessFor } from '@/src/lib/users/permissions';
import * as schema from '@/src/lib/db/schema';
import { seedUser } from '../../helpers/settings-actions';

const NOW = new Date().toISOString();
const ADMIN_ACTOR = {
  userId: 0,
  role: 'admin',
  capabilities: capabilitySetOf([BUILT_IN_ROLES.admin]),
};

async function thrown(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'allowed';
}

let admin: Awaited<ReturnType<typeof seedUser>>;
let manager: Awaited<ReturnType<typeof seedUser>>;
let managerRole: string;

beforeEach(async () => {
  await ctx.db.delete(schema.groupGrants);
  await ctx.db.delete(schema.groupMembers);
  await ctx.db.delete(schema.groups);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.delete(schema.roles);
  managerRole = (
    await createRole(
      { name: 'People', capabilities: ['users:write', 'groups:write', 'roles:write'] },
      ADMIN_ACTOR,
    )
  ).key;
  admin = await seedUser(ctx.db, 'admin@example.com', 'admin');
  manager = await seedUser(ctx.db, 'people@example.com', managerRole);
  ctx.session = { user: admin };
});

describe('the Roles page', () => {
  it('makes, changes and deletes a role for an administrator', async () => {
    const made = await saveRoleAction(null, { name: 'Auditors', capabilities: ['audit:read'] });
    const changed = await saveRoleAction(made.key, {
      name: 'Auditors',
      capabilities: ['audit:write'],
    });
    expect(changed.capabilities).toEqual(['audit:read', 'audit:write']);
    await deleteRoleAction(made.key);
    expect(await ctx.db.select().from(schema.roles)).toHaveLength(1);
  });

  it('turns a made role away from more than it holds, and from its own role', async () => {
    ctx.session = { user: manager };
    expect(
      await thrown(saveRoleAction(null, { name: 'Wider', capabilities: ['settings:read'] })),
    ).toContain('permissions you hold');
    expect(
      await thrown(saveRoleAction(managerRole, { name: 'People', capabilities: [] })),
    ).toContain('role you hold');
    const narrow = await saveRoleAction(null, { name: 'Narrow', capabilities: ['users:read'] });
    expect(narrow.capabilities).toEqual(['users:read']);
  });

  it('is refused to a role without roles:write', async () => {
    ctx.session = { user: await seedUser(ctx.db, 'viewer@example.com', 'viewer') };
    expect(await thrown(saveRoleAction(null, { name: 'X', capabilities: [] }))).toContain(
      'You do not have access',
    );
  });
});

describe('a group', () => {
  async function seedGroup(role: string | null = null): Promise<number> {
    const [row] = await ctx.db
      .insert(schema.groups)
      .values({ name: 'g', role, createdAt: NOW, updatedAt: NOW })
      .returning({ id: schema.groups.id });
    return row.id;
  }

  it('gives a role an administrator sets, and never admin', async () => {
    const id = await seedGroup();
    await setGroupRoleAction(id, 'operator');
    const [row] = await ctx.db.select().from(schema.groups);
    expect(row.role).toBe('operator');
    expect(await thrown(setGroupRoleAction(id, 'admin'))).toContain('administrator role');
  });

  it('cannot be joined by a manager when it gives more than the manager holds', async () => {
    const id = await seedGroup('operator');
    ctx.session = { user: manager };
    expect(await thrown(addGroupMemberAction(id, Number(manager.id)))).toContain(
      'permissions you hold',
    );
    expect(await ctx.db.select().from(schema.groupMembers)).toEqual([]);
  });

  it('takes grants only from someone who manages every host', async () => {
    const id = await seedGroup();
    await ctx.db.insert(schema.proxyHosts).values({
      id: 1,
      name: 'h',
      domains: '["h.example.com"]',
      upstreams: '["a:80"]',
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.session = { user: manager };
    const grant = [
      { resource: { kind: 'proxyHost' as const, id: 1 }, capability: 'manage' as const },
    ];
    expect(await thrown(setGroupGrantsAction(id, grant))).toContain('permissions you hold');
    ctx.session = { user: admin };
    await setGroupGrantsAction(id, grant);
    expect(await ctx.db.select().from(schema.groupGrants)).toHaveLength(1);
  });
});

describe('a user', () => {
  it('gets a made role from an administrator', async () => {
    const target = await seedUser(ctx.db, 'target@example.com', 'viewer');
    expect(await updateUserRoleAction(Number(target.id), managerRole)).toEqual({
      status: 'success',
    });
    const [row] = await ctx.db
      .select()
      .from(schema.users)
      .where((await import('drizzle-orm')).eq(schema.users.id, Number(target.id)));
    expect(row.role).toBe(managerRole);
  });

  it('cannot be raised above, nor changed when above, a manager', async () => {
    const target = await seedUser(ctx.db, 'target@example.com', 'viewer');
    ctx.session = { user: manager };
    expect(await updateUserRoleAction(Number(target.id), 'operator')).toMatchObject({
      status: 'error',
    });
    expect(await updateUserStatusAction(Number(admin.id), 'disabled')).toMatchObject({
      status: 'error',
    });
    expect(await updateUserRoleAction(Number(target.id), 'user')).toEqual({ status: 'success' });
  });
});

describe('over GraphQL', () => {
  function contextFor(user: { id: string; role: string }): GraphQLContext {
    return {
      viewer: async () => ({ userId: Number(user.id), role: user.role, authMethod: 'session' }),
      access: () => accessFor(Number(user.id), user.role),
      rawBody: async () => '',
      request: {} as never,
    };
  }

  async function run(source: string, user = admin, variableValues?: Record<string, unknown>) {
    const result = await graphql({
      schema: servedSchema,
      source,
      contextValue: contextFor(user),
      variableValues,
    });
    return {
      data: result.data as Record<string, any>,
      errors: result.errors?.map((e) => e.message),
    };
  }

  it('lists, makes, changes and deletes roles, and sets a group role', async () => {
    const listed = await run('{ roles { key name builtIn scoped capabilities } capabilities }');
    expect(listed.errors).toBeUndefined();
    expect(listed.data.roles.map((role: { key: string }) => role.key).slice(0, 4)).toEqual([
      'admin',
      'operator',
      'user',
      'viewer',
    ]);
    expect(listed.data.capabilities).toContain('roles:write');

    const made = await run(
      'mutation ($input: JSON!) { createRole(input: $input) { key name capabilities } }',
      admin,
      { input: { name: 'Auditors', capabilities: ['audit:read'] } },
    );
    expect(made.errors).toBeUndefined();
    const key = made.data.createRole.key;
    const changed = await run(
      'mutation ($key: String!, $input: JSON!) { updateRole(key: $key, input: $input) { scoped } }',
      admin,
      { key, input: { name: 'Auditors', capabilities: ['audit:read'], scoped: true } },
    );
    expect(changed.data.updateRole.scoped).toBe(true);
    expect((await run(`{ role(key: "${key}") { name } }`)).data.role.name).toBe('Auditors');

    const [group] = await ctx.db
      .insert(schema.groups)
      .values({ name: 'g', createdAt: NOW, updatedAt: NOW })
      .returning({ id: schema.groups.id });
    const set = await run(
      `mutation { setGroupRole(groupId: ${group.id}, role: "${key}") { role } }`,
    );
    expect(set.data.setGroupRole.role).toBe(key);
    const inUse = await run(`mutation { deleteRole(key: "${key}") }`);
    expect(inUse.errors?.[0]).toContain('still given');
    await run(`mutation { setGroupRole(groupId: ${group.id}) { role } }`);
    expect((await run(`mutation { deleteRole(key: "${key}") }`)).data.deleteRole).toBe(true);
    expect(
      (await run('mutation { setGroupRole(groupId: 999999) { role } }')).errors?.[0],
    ).toContain('not found');
  });

  it('refuses roles to a role without them', async () => {
    const viewer = await seedUser(ctx.db, 'viewer@example.com', 'viewer');
    expect((await run('{ roles { key } }', viewer)).errors?.[0]).toBe(
      "This account's role does not allow this request",
    );
  });
});
