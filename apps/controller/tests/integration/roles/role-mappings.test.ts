/**
 * Identity-provider groups to roles, one row a name. The migration that moved them out of the four
 * columns keeps every provider mapping the same claims to the same role; a backup or legacy
 * database from before it converts the same way; and a made role ranks after operator.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb, createTestDbBefore } = await import('../../helpers/db');

const fresh = await createTestDb();
ctx.db = fresh;

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { asc } from 'drizzle-orm';
import { mapGroupsToRole, toGroupMappingConfig } from '../../../src/lib/auth/oidc/groups';
import { BUILT_IN_ROLES } from '../../../src/lib/roles/built-in';
import { capabilitySetOf } from '../../../src/lib/roles/capabilities';
import { createRole } from '../../../src/lib/roles/store';
import { legacyRoleMappings, roleGroupsOf, setRoleGroups } from '../../../src/lib/roles/mappings';
import {
  createOAuthProvider,
  getOAuthProvider,
  updateOAuthProvider,
} from '../../../src/lib/models/oauth-providers';
import * as schema from '../../../src/lib/db/schema';

const NOW = '2026-05-01T00:00:00.000Z';
const ADMIN = { userId: 1, role: 'admin', capabilities: capabilitySetOf([BUILT_IN_ROLES.admin]) };

/** Claim sets that tell the four built-in roles apart, prefix fallback included. */
const CLAIMS = [
  [],
  ['cpm-admins'],
  ['Ops Team'],
  ['/Parent/Admins'],
  ['ops'],
  ['staff', 'ops'],
  ['CPM_Viewer'],
  ['CPM_User', 'readers'],
  ['nobody'],
];

const LEGACY = [
  {
    id: 'a-provider',
    adminGroup: 'cpm-admins, Ops Team ,,/Parent/Admins',
    operatorGroup: 'ops',
    userGroup: null,
    viewerGroup: ' ',
    groupPrefix: 'CPM_',
    defaultRole: 'viewer',
  },
  {
    id: 'b-provider',
    adminGroup: null,
    operatorGroup: null,
    userGroup: 'staff,staff,readers',
    viewerGroup: null,
    groupPrefix: null,
    defaultRole: 'user',
  },
];

afterEach(() => {
  ctx.db = fresh;
});

describe('the migration', () => {
  it('moves each comma list into rows, and every claim maps to the role it did', async () => {
    const seeded = await createTestDbBefore('custom_roles');
    for (const provider of LEGACY) {
      const groupPrefix = provider.groupPrefix === null ? 'NULL' : `'${provider.groupPrefix}'`;
      const quote = (value: string | null) => (value === null ? 'NULL' : `'${value}'`);
      await seeded.exec(`INSERT INTO oauth_providers
        (id, name, type, "clientId", "clientSecret", scopes, "autoLink", enabled, source,
         "groupsClaim", "groupPrefix", "roleMappingEnabled", "adminGroup", "operatorGroup",
         "userGroup", "viewerGroup", "defaultRole", "syncGroups", "createdAt", "updatedAt")
        VALUES ('${provider.id}', '${provider.id}', 'oidc', 'c', 's', 'openid', false, true, 'ui',
         'groups', ${groupPrefix}, true, ${quote(provider.adminGroup)},
         ${quote(provider.operatorGroup)}, ${quote(provider.userGroup)},
         ${quote(provider.viewerGroup)}, '${provider.defaultRole}', false, '${NOW}', '${NOW}')`);
    }
    await seeded.migrateRest();
    ctx.db = seeded.db;

    const rows = await ctx.db
      .select({
        id: schema.roleMappings.id,
        providerId: schema.roleMappings.providerId,
        role: schema.roleMappings.role,
        externalName: schema.roleMappings.externalName,
      })
      .from(schema.roleMappings)
      .orderBy(asc(schema.roleMappings.id));
    expect(rows).toEqual([
      { id: 1, providerId: 'a-provider', role: 'admin', externalName: 'cpm-admins' },
      { id: 2, providerId: 'a-provider', role: 'admin', externalName: 'Ops Team' },
      { id: 3, providerId: 'a-provider', role: 'admin', externalName: '/Parent/Admins' },
      { id: 4, providerId: 'a-provider', role: 'operator', externalName: 'ops' },
      { id: 5, providerId: 'b-provider', role: 'user', externalName: 'staff' },
      { id: 6, providerId: 'b-provider', role: 'user', externalName: 'readers' },
    ]);
    // The same rows a backup or legacy database from before it is restored into.
    expect(legacyRoleMappings(LEGACY.map((provider) => ({ ...provider, updatedAt: NOW })))).toEqual(
      rows.map((row) => ({ ...row, createdAt: NOW })),
    );

    for (const provider of LEGACY) {
      const before = toGroupMappingConfig({ ...provider, roleMappingEnabled: true });
      const after = toGroupMappingConfig({
        groupPrefix: provider.groupPrefix,
        defaultRole: provider.defaultRole,
        roleMappingEnabled: true,
        roleGroups: await roleGroupsOf(provider.id),
      });
      for (const claims of CLAIMS) {
        expect({ provider: provider.id, claims, role: mapGroupsToRole(claims, after) }).toEqual({
          provider: provider.id,
          claims,
          role: mapGroupsToRole(claims, before),
        });
      }
    }
  });
});

describe('a provider', () => {
  beforeEach(async () => {
    await ctx.db.delete(schema.roleMappings);
    await ctx.db.delete(schema.oauthProviders);
    await ctx.db.delete(schema.roles);
  });

  it('keeps the comma lists a form sends, and reads them back the same', async () => {
    const created = await createOAuthProvider({
      name: 'IdP',
      clientId: 'c',
      clientSecret: 's',
      roleMappingEnabled: true,
      adminGroup: 'admins, owners',
      viewerGroup: 'readers',
    });
    expect(created).toMatchObject({
      adminGroup: 'admins, owners',
      operatorGroup: null,
      viewerGroup: 'readers',
      roleGroups: { admin: ['admins', 'owners'], viewer: ['readers'] },
    });
    await updateOAuthProvider(created.id, { adminGroup: null });
    expect(await getOAuthProvider(created.id)).toMatchObject({
      adminGroup: null,
      viewerGroup: 'readers',
    });
  });

  it('maps a made role, ranked after operator and before user', async () => {
    const auditors = await createRole({ name: 'Auditors', capabilities: ['audit:read'] }, ADMIN);
    const provider = await createOAuthProvider({
      name: 'IdP',
      clientId: 'c',
      clientSecret: 's',
      roleMappingEnabled: true,
      operatorGroup: 'ops',
      userGroup: 'staff',
      roleGroups: { [auditors.key]: ['audit'] },
      defaultRole: auditors.key,
    });
    const mapping = toGroupMappingConfig(provider);
    expect(mapGroupsToRole(['staff', 'audit'], mapping)).toBe(auditors.key);
    expect(mapGroupsToRole(['ops', 'audit'], mapping)).toBe('operator');
    expect(mapGroupsToRole(['other'], mapping)).toBe(auditors.key);
  });

  it('refuses a mapping to a role that does not exist, and writes nothing unchanged', async () => {
    const provider = await createOAuthProvider({ name: 'IdP', clientId: 'c', clientSecret: 's' });
    let refused: unknown = null;
    try {
      await setRoleGroups(provider.id, { 'role-0123456789ab': ['x'] });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ code: 'invalidUserRole' });

    await setRoleGroups(provider.id, { admin: ['a', 'b'] });
    const before = await ctx.db.select().from(schema.roleMappings);
    await setRoleGroups(provider.id, { admin: ['a', 'b'] });
    expect(await ctx.db.select().from(schema.roleMappings)).toEqual(before);
  });

  it('falls back to user for a default role that does not exist', async () => {
    const provider = await createOAuthProvider({
      name: 'IdP',
      clientId: 'c',
      clientSecret: 's',
      defaultRole: 'superadmin',
    });
    expect(provider.defaultRole).toBe('user');
  });
});
