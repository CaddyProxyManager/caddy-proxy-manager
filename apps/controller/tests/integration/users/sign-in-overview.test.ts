/** The sign-in overview's facts, from the same tables sign-in reads. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const directory = {
  id: 'corp',
  name: 'Corp directory',
  enabled: true,
  syncGroups: false,
  roleMappingEnabled: true,
  adminGroup: 'cpm-admins',
  operatorGroup: null,
  userGroup: null,
  viewerGroup: null,
  defaultRole: 'viewer',
};

// A directory's settings and its network check are not what is under test.
vi.mock('../../../src/lib/models/ldap-directories', () => ({
  listLdapDirectories: async () => [directory],
  listEnabledLdapDirectories: async () => [directory],
}));
vi.mock('../../../src/lib/ldap/health', () => ({
  checkLdapDirectories: async () => new Map([['corp', { at: Date.now(), failure: 'bind' }]]),
}));

import { getSignInOverview } from '@/src/lib/users/sign-in-overview';
import { saveTwoFactorPolicySettings } from '@/src/lib/settings';
import {
  accounts,
  groupIdpMappings,
  groups,
  oauthProviders,
  roleMappings,
  passkeys,
  settings,
  users,
} from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();

beforeEach(async () => {
  for (const table of [
    groupIdpMappings,
    groups,
    passkeys,
    accounts,
    users,
    roleMappings,
    oauthProviders,
    settings,
  ]) {
    await ctx.db.delete(table);
  }
  await ctx.db.insert(oauthProviders).values({
    id: 'idp',
    name: 'Company SSO',
    type: 'oidc',
    clientId: 'x',
    clientSecret: 'x',
    autoLink: true,
    enabled: true,
    source: 'ui',
    roleMappingEnabled: true,
    defaultRole: 'user',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db
    .insert(roleMappings)
    .values({ providerId: 'idp', role: 'admin', externalName: 'ops', createdAt: NOW });
  const [local] = await ctx.db
    .insert(users)
    .values({
      email: 'a@example.com',
      passwordHash: 'hash',
      role: 'admin',
      twoFactorEnabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: users.id });
  const [sso] = await ctx.db
    .insert(users)
    .values({ email: 'b@example.com', role: 'user', createdAt: NOW, updatedAt: NOW })
    .returning({ id: users.id });
  await ctx.db.insert(accounts).values([
    { userId: sso.id, accountId: 'b', providerId: 'idp', createdAt: NOW, updatedAt: NOW },
    { userId: local.id, accountId: 'a', providerId: 'corp', createdAt: NOW, updatedAt: NOW },
  ]);
  await ctx.db.insert(passkeys).values({
    userId: local.id,
    publicKey: 'k',
    credentialID: 'c1',
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    createdAt: NOW,
  });
  const [group] = await ctx.db
    .insert(groups)
    .values({ name: 'Web team', createdAt: NOW, updatedAt: NOW })
    .returning({ id: groups.id });
  await ctx.db.insert(groupIdpMappings).values({
    groupId: group.id,
    providerId: 'idp',
    externalName: 'web',
    externalKey: 'web',
    createdAt: NOW,
  });
  await saveTwoFactorPolicySettings({ mode: 'admins', graceDays: 14 });
});

describe('the sign-in overview', () => {
  it('counts the accounts behind each method', async () => {
    const overview = await getSignInOverview();
    expect(overview.password).toMatchObject({ enabled: true, accounts: 1 });
    expect(overview.passkeys).toMatchObject({ registered: 1, accounts: 1 });
    expect(overview.providers).toEqual([
      expect.objectContaining({ id: 'idp', name: 'Company SSO', linked: 1, autoLink: true }),
    ]);
    expect(overview.directories).toEqual([
      expect.objectContaining({ id: 'corp', linked: 1, health: 'unreachable', failure: 'bind' }),
    ]);
  });

  it('lists role and group mappings and the second-factor policy', async () => {
    const overview = await getSignInOverview();
    expect(overview.providers[0].roles).toMatchObject({ enabled: true, admin: 'ops' });
    expect(overview.directories[0].roles).toMatchObject({ admin: 'cpm-admins' });
    expect(overview.groupMappings).toEqual([
      { group: 'Web team', provider: 'Company SSO', externalName: 'web' },
    ]);
    expect(overview.mfa).toEqual({ mode: 'admins', graceDays: 14, withTotp: 1, withPasskey: 1 });
  });
});
