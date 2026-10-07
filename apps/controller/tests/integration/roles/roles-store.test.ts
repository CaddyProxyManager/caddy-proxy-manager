/**
 * Roles an administrator makes: what they hold, and the guards around them. A role is never a way
 * to more than its author holds, one in use cannot be deleted, and nobody rewrites the role they
 * hold themselves.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { logAuditEvent } from '../../../src/lib/audit';
import { BUILT_IN_ROLES } from '../../../src/lib/roles/built-in';
import { capabilitySetOf } from '../../../src/lib/roles/capabilities';
import {
  assertMayAssignRole,
  assertMayManageAccount,
  createRole,
  deleteRole,
  getRole,
  isCustomRoleKey,
  isKnownRole,
  listRoles,
  roleUsage,
  updateRole,
} from '../../../src/lib/roles/store';
import { DomainError } from '../../../src/lib/errors/domain-error';
import * as schema from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();
const ADMIN = { userId: 1, role: 'admin', capabilities: capabilitySetOf([BUILT_IN_ROLES.admin]) };

async function failure(work: Promise<unknown>): Promise<DomainError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  await ctx.db.delete(schema.roleMappings);
  await ctx.db.delete(schema.oauthProviders);
  await ctx.db.delete(schema.groups);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.delete(schema.roles);
  vi.mocked(logAuditEvent).mockClear();
});

describe('a made role', () => {
  it('is created, listed after the built-in ones, and audited', async () => {
    const role = await createRole(
      { name: ' Auditors ', description: 'Reads the log', capabilities: ['audit:read'] },
      ADMIN,
    );
    expect(isCustomRoleKey(role.key)).toBe(true);
    expect(role).toMatchObject({ name: 'Auditors', capabilities: ['audit:read'], scoped: false });
    expect((await listRoles()).map((entry) => entry.key)).toEqual([
      'admin',
      'operator',
      'user',
      'viewer',
      role.key,
    ]);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        entityType: 'role',
        summary: 'Created role Auditors',
      }),
    );
  });

  it('brings each write its read, and keeps the key across a rename', async () => {
    const role = await createRole({ name: 'Hosts', capabilities: ['hosts:write'] }, ADMIN);
    const renamed = await updateRole(
      role.key,
      { name: 'Host team', capabilities: ['hosts:write'], scoped: true },
      ADMIN,
    );
    expect(renamed).toMatchObject({
      key: role.key,
      name: 'Host team',
      capabilities: ['hosts:read', 'hosts:write'],
      scoped: true,
    });
  });

  it('refuses a name another role has, a built-in key, or none at all', async () => {
    await createRole({ name: 'Auditors', capabilities: [] }, ADMIN);
    expect((await failure(createRole({ name: 'auditors', capabilities: [] }, ADMIN))).code).toBe(
      'roleNameTaken',
    );
    expect((await failure(createRole({ name: 'Operator', capabilities: [] }, ADMIN))).code).toBe(
      'roleNameTaken',
    );
    expect((await failure(createRole({ name: '  ', capabilities: [] }, ADMIN))).code).toBe(
      'roleNameInvalid',
    );
  });

  it('refuses a permission that does not exist', async () => {
    const refused = await failure(createRole({ name: 'X', capabilities: ['hosts:delete'] }, ADMIN));
    expect(refused.code).toBe('roleCapabilityInvalid');
  });

  it('cannot hold more than its author does, as it is made, changed or deleted', async () => {
    const auditor = {
      userId: 2,
      role: 'auditor',
      capabilities: capabilitySetOf([
        { key: 'auditor', capabilities: ['audit:read', 'roles:write'], scoped: false },
      ]),
    };
    expect(
      (await failure(createRole({ name: 'Wider', capabilities: ['settings:write'] }, auditor)))
        .code,
    ).toBe('roleExceedsYours');

    const wide = await createRole({ name: 'Wide', capabilities: ['settings:write'] }, ADMIN);
    expect(
      (await failure(updateRole(wide.key, { name: 'Wide', capabilities: [] }, auditor))).code,
    ).toBe('roleExceedsYours');
    expect((await failure(deleteRole(wide.key, auditor))).code).toBe('roleExceedsYours');

    const narrow = await createRole({ name: 'Narrow', capabilities: ['audit:read'] }, auditor);
    expect(narrow.capabilities).toEqual(['audit:read']);
  });

  it('is not its holder to change or delete', async () => {
    const role = await createRole({ name: 'Mine', capabilities: ['roles:write'] }, ADMIN);
    const holder = { ...ADMIN, userId: 3, role: role.key };
    expect(
      (await failure(updateRole(role.key, { name: 'Mine', capabilities: [] }, holder))).code,
    ).toBe('cannotEditOwnRole');
    expect((await failure(deleteRole(role.key, holder))).code).toBe('cannotEditOwnRole');
  });
});

describe('the built-in roles', () => {
  it('are listed, unnamed, and cannot be changed or deleted', async () => {
    expect(await getRole('operator')).toMatchObject({ builtIn: true, name: null, scoped: true });
    expect((await failure(updateRole('viewer', { name: 'X', capabilities: [] }, ADMIN))).code).toBe(
      'roleBuiltIn',
    );
    expect((await failure(deleteRole('admin', ADMIN))).code).toBe('roleBuiltIn');
  });

  it('are known, and a key of no role is not', async () => {
    expect(await isKnownRole('viewer')).toBe(true);
    expect(await isKnownRole('superadmin')).toBe(false);
    expect(await isKnownRole('role-000000000000')).toBe(false);
  });
});

describe('a role in use', () => {
  it('cannot be deleted while a user, group, mapping or default names it', async () => {
    const role = await createRole({ name: 'Ops', capabilities: ['hosts:read'] }, ADMIN);
    await ctx.db.insert(schema.users).values({
      id: 10,
      email: 'ops@example.com',
      role: role.key,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert(schema.groups).values({
      name: 'Ops team',
      role: role.key,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert(schema.oauthProviders).values({
      id: 'idp',
      name: 'IdP',
      clientId: 'c',
      clientSecret: 's',
      defaultRole: role.key,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db
      .insert(schema.roleMappings)
      .values({ providerId: 'idp', role: role.key, externalName: 'ops', createdAt: NOW });

    expect(await roleUsage(role.key)).toEqual({ users: 1, groups: 1, mappings: 1, providers: 1 });
    expect((await failure(deleteRole(role.key, ADMIN))).code).toBe('roleInUse');

    await ctx.db.delete(schema.users);
    await ctx.db.delete(schema.groups);
    await ctx.db.delete(schema.oauthProviders);
    await deleteRole(role.key, ADMIN);
    expect(await getRole(role.key)).toBeNull();
  });
});

describe('handing a role out', () => {
  it('needs all of it held outright', async () => {
    const operator = capabilitySetOf([BUILT_IN_ROLES.operator]);
    expect((await assertMayAssignRole(operator, 'viewer')).key).toBe('viewer');
    expect((await failure(assertMayAssignRole(operator, 'operator'))).code).toBe(
      'roleExceedsYours',
    );
    expect((await failure(assertMayAssignRole(operator, 'nobody'))).code).toBe('invalidUserRole');
  });

  it('and acting on an account needs at least what it holds', async () => {
    const users = capabilitySetOf([{ key: 'u', capabilities: ['users:write'], scoped: false }]);
    await assertMayManageAccount(users, 'viewer');
    await assertMayManageAccount(users, 'nobody');
    expect((await failure(assertMayManageAccount(users, 'admin'))).code).toBe(
      'accountExceedsYours',
    );
  });
});
