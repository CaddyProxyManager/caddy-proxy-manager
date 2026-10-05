/**
 * Group-claim → role/group mapping. These rules decide who becomes an admin, so
 * every shape an IdP can return and every prefix edge case is pinned here.
 */
import { describe, it, expect } from 'bun:test';
import {
  envGroupMapping,
  extractGroups,
  mapGroupsToLocalGroups,
  mapGroupsToRole,
  needsGroupClaims,
  normalizeGroupName,
  parseGroupNames,
  readClaim,
  resolveRoleGroups,
  toGroupMappingConfig,
} from '../../../src/lib/auth/oidc/groups';

const base = toGroupMappingConfig({
  groupsClaim: 'groups',
  groupPrefix: 'CPM_',
  roleMappingEnabled: true,
});

describe('toGroupMappingConfig', () => {
  it('applies safe defaults for an unconfigured provider', () => {
    const cfg = toGroupMappingConfig({});
    expect(cfg).toEqual({
      groupsClaim: 'groups',
      groupPrefix: null,
      roleMappingEnabled: false,
      adminGroup: null,
      operatorGroup: null,
      userGroup: null,
      viewerGroup: null,
      defaultRole: 'user',
      syncGroups: false,
    });
  });

  it('falls back to "user" for an unrecognised defaultRole', () => {
    expect(toGroupMappingConfig({ defaultRole: 'superadmin' }).defaultRole).toBe('user');
  });

  it('treats blank strings as unset', () => {
    const cfg = toGroupMappingConfig({ groupsClaim: '   ', groupPrefix: '  ', adminGroup: '' });
    expect(cfg.groupsClaim).toBe('groups');
    expect(cfg.groupPrefix).toBeNull();
    expect(cfg.adminGroup).toBeNull();
  });
});

describe('needsGroupClaims', () => {
  it('is false until role mapping or group sync is turned on', () => {
    expect(needsGroupClaims(toGroupMappingConfig({}))).toBe(false);
    expect(needsGroupClaims(toGroupMappingConfig({ roleMappingEnabled: true }))).toBe(true);
    expect(needsGroupClaims(toGroupMappingConfig({ syncGroups: true }))).toBe(true);
  });
});

describe('readClaim', () => {
  it('reads a nested claim through a dotted path', () => {
    const claims = { resource_access: { cpm: { roles: ['CPM_Admin'] } } };
    expect(readClaim(claims, 'resource_access.cpm.roles')).toEqual(['CPM_Admin']);
  });

  it('returns undefined for a missing path instead of throwing', () => {
    expect(readClaim({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(readClaim({}, 'groups')).toBeUndefined();
  });
});

describe('normalizeGroupName', () => {
  it('keeps only the last segment of a Keycloak-style group path', () => {
    expect(normalizeGroupName('/Parent/CPM_Admin')).toBe('CPM_Admin');
    expect(normalizeGroupName('  CPM_Admin  ')).toBe('CPM_Admin');
  });
});

describe('extractGroups', () => {
  it('reads an array of strings', () => {
    expect(extractGroups({ groups: ['CPM_Admin', 'Other'] }, 'groups')).toEqual([
      'CPM_Admin',
      'Other',
    ]);
  });

  it('reads an array of objects by name', () => {
    const claims = { groups: [{ name: 'CPM_Admin' }, { path: '/x/CPM_Ops' }, { id: 'CPM_Net' }] };
    expect(extractGroups(claims, 'groups')).toEqual(['CPM_Admin', 'CPM_Ops', 'CPM_Net']);
  });

  it('splits a comma-separated string but keeps spaces inside names', () => {
    expect(extractGroups({ groups: 'CPM_Admin, Platform Team' }, 'groups')).toEqual([
      'CPM_Admin',
      'Platform Team',
    ]);
  });

  it('parses a JSON-encoded array', () => {
    expect(extractGroups({ groups: '["CPM_Admin","CPM_User"]' }, 'groups')).toEqual([
      'CPM_Admin',
      'CPM_User',
    ]);
  });

  it('de-duplicates case-insensitively', () => {
    expect(extractGroups({ groups: ['CPM_Admin', 'cpm_admin'] }, 'groups')).toEqual(['CPM_Admin']);
  });

  it('returns an empty list when the claim is missing or unusable', () => {
    expect(extractGroups({}, 'groups')).toEqual([]);
    expect(extractGroups({ groups: null }, 'groups')).toEqual([]);
    expect(extractGroups({ groups: 42 }, 'groups')).toEqual([]);
  });
});

describe('parseGroupNames', () => {
  it('splits on commas and trims', () => {
    expect(parseGroupNames('platform-owners, sre-oncall')).toEqual([
      'platform-owners',
      'sre-oncall',
    ]);
  });

  it('keeps spaces inside a name', () => {
    expect(parseGroupNames('Platform Team, SRE On-Call')).toEqual(['Platform Team', 'SRE On-Call']);
  });

  it('strips group paths and drops empties and duplicates', () => {
    expect(parseGroupNames('/company/Admins, , admins')).toEqual(['Admins']);
  });

  it('treats null and blank as unconfigured', () => {
    expect(parseGroupNames(null)).toEqual([]);
    expect(parseGroupNames('  ,  ')).toEqual([]);
  });
});

describe('resolveRoleGroups', () => {
  it('derives role groups from the prefix', () => {
    expect(resolveRoleGroups(base)).toEqual({
      admin: ['CPM_Admin'],
      operator: ['CPM_Operator'],
      user: ['CPM_User'],
      viewer: ['CPM_Viewer'],
    });
  });

  it('lets custom names be given for every role, with no prefix at all', () => {
    const cfg = toGroupMappingConfig({
      roleMappingEnabled: true,
      adminGroup: 'platform-owners',
      operatorGroup: 'proxy-ops',
      userGroup: 'staff',
      viewerGroup: 'auditors',
    });
    expect(resolveRoleGroups(cfg)).toEqual({
      admin: ['platform-owners'],
      operator: ['proxy-ops'],
      user: ['staff'],
      viewer: ['auditors'],
    });
  });

  it('accepts several groups for one role', () => {
    const cfg = toGroupMappingConfig({ adminGroup: 'platform-owners, sre-oncall' });
    expect(resolveRoleGroups(cfg).admin).toEqual(['platform-owners', 'sre-oncall']);
  });

  it('mixes custom names with the prefix convention per role', () => {
    const cfg = toGroupMappingConfig({ groupPrefix: 'CPM_', adminGroup: 'platform-owners' });
    expect(resolveRoleGroups(cfg).admin).toEqual(['platform-owners']);
    expect(resolveRoleGroups(cfg).user).toEqual(['CPM_User']);
    expect(resolveRoleGroups(cfg).viewer).toEqual(['CPM_Viewer']);
  });

  it('resolves to nothing without a prefix or a custom name', () => {
    expect(resolveRoleGroups(toGroupMappingConfig({}))).toEqual({
      admin: [],
      operator: [],
      user: [],
      viewer: [],
    });
  });
});

describe('mapGroupsToRole', () => {
  it('grants admin to a member of <prefix>Admin', () => {
    expect(mapGroupsToRole(['CPM_Admin'], base)).toBe('admin');
  });

  it('matches case-insensitively and through a group path', () => {
    expect(mapGroupsToRole(['/company/cpm_admin'], base)).toBe('admin');
  });

  it('takes the most privileged matching group', () => {
    expect(mapGroupsToRole(['CPM_Viewer', 'CPM_Admin', 'CPM_User'], base)).toBe('admin');
  });

  it('ranks operator above user and viewer, and below admin', () => {
    // An operator manages its groups' grants; a user or viewer nothing. So operator beats user, and
    // losing the admin group demotes to operator rather than all the way to user.
    expect(mapGroupsToRole(['CPM_User', 'CPM_Operator'], base)).toBe('operator');
    expect(mapGroupsToRole(['CPM_Viewer', 'CPM_Operator'], base)).toBe('operator');
    expect(mapGroupsToRole(['CPM_Operator', 'CPM_Admin'], base)).toBe('admin');
  });

  it('falls back to the configured default when nothing matches', () => {
    expect(mapGroupsToRole(['Marketing'], base)).toBe('user');
    expect(
      mapGroupsToRole(['Marketing'], toGroupMappingConfig({ ...base, defaultRole: 'viewer' })),
    ).toBe('viewer');
  });

  it('returns null - leaving the role untouched - when mapping is off', () => {
    expect(
      mapGroupsToRole(['CPM_Admin'], toGroupMappingConfig({ groupPrefix: 'CPM_' })),
    ).toBeNull();
  });

  it('does not treat an unrelated group that starts with the prefix as a role', () => {
    expect(mapGroupsToRole(['CPM_Administrators'], base)).toBe('user');
  });

  describe('with custom group names instead of a prefix', () => {
    const custom = toGroupMappingConfig({
      roleMappingEnabled: true,
      adminGroup: 'platform-owners, sre-oncall',
      operatorGroup: 'platform-owners, sre-oncall',
      userGroup: 'staff',
      viewerGroup: 'auditors, contractors',
    });

    it('grants each role from its own named groups', () => {
      expect(mapGroupsToRole(['platform-owners'], custom)).toBe('admin');
      expect(mapGroupsToRole(['staff'], custom)).toBe('user');
      expect(mapGroupsToRole(['auditors'], custom)).toBe('viewer');
    });

    it('grants the role from any one of the groups listed for it', () => {
      expect(mapGroupsToRole(['sre-oncall'], custom)).toBe('admin');
      expect(mapGroupsToRole(['contractors'], custom)).toBe('viewer');
    });

    it('still takes the most privileged match across roles', () => {
      expect(mapGroupsToRole(['auditors', 'sre-oncall', 'staff'], custom)).toBe('admin');
    });

    it('matches case-insensitively and through a group path', () => {
      expect(mapGroupsToRole(['/company/PLATFORM-OWNERS'], custom)).toBe('admin');
    });

    it('falls back to the default role for an unlisted group', () => {
      expect(mapGroupsToRole(['marketing'], custom)).toBe('user');
    });
  });
});

describe('mapGroupsToLocalGroups', () => {
  const syncing = toGroupMappingConfig({
    groupPrefix: 'CPM_',
    roleMappingEnabled: true,
    syncGroups: true,
  });

  it('mirrors prefixed groups with the prefix stripped', () => {
    expect(mapGroupsToLocalGroups(['CPM_Devs', 'CPM_Ops'], syncing)).toEqual(['Devs', 'Ops']);
  });

  it('skips groups that do not carry the prefix', () => {
    expect(mapGroupsToLocalGroups(['Devs', 'CPM_Ops'], syncing)).toEqual(['Ops']);
  });

  it('excludes the role groups so they do not become CPM groups', () => {
    expect(
      mapGroupsToLocalGroups(['CPM_Admin', 'CPM_User', 'CPM_Viewer', 'CPM_Devs'], syncing),
    ).toEqual(['Devs']);
  });

  it('mirrors every group verbatim when no prefix is set', () => {
    const cfg = toGroupMappingConfig({ syncGroups: true });
    expect(mapGroupsToLocalGroups(['Devs', 'Ops'], cfg)).toEqual(['Devs', 'Ops']);
  });

  it('excludes custom-named role groups, including every name listed for a role', () => {
    const cfg = toGroupMappingConfig({
      roleMappingEnabled: true,
      syncGroups: true,
      adminGroup: 'platform-owners, sre-oncall',
      operatorGroup: 'platform-owners, sre-oncall',
      viewerGroup: 'auditors',
    });
    expect(
      mapGroupsToLocalGroups(['platform-owners', 'sre-oncall', 'auditors', 'Devs'], cfg),
    ).toEqual(['Devs']);
  });

  it('returns nothing when group sync is off', () => {
    expect(mapGroupsToLocalGroups(['CPM_Devs'], base)).toEqual([]);
  });
});

describe('envGroupMapping', () => {
  const env = {
    groupsClaim: null,
    groupPrefix: null,
    roleMappingEnabled: true,
    adminGroup: null,
    operatorGroup: null,
    userGroup: null,
    viewerGroup: null,
    defaultRole: null,
    syncGroups: false,
  };

  it('keeps every role as OAUTH_DEFAULT_ROLE, operator included', () => {
    for (const role of ['admin', 'operator', 'user', 'viewer'] as const) {
      expect(envGroupMapping({ ...env, defaultRole: role }).defaultRole).toBe(role);
    }
  });

  it('falls back to user for an unset or unknown role, and to the groups claim', () => {
    expect(envGroupMapping(env)).toMatchObject({ defaultRole: 'user', groupsClaim: 'groups' });
    expect(envGroupMapping({ ...env, defaultRole: 'root' }).defaultRole).toBe('user');
  });
});
