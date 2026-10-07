/**
 * The OIDC provider model against a real database: no reader or writer here may see or make an
 * LDAP directory, an environment-defined provider cannot be deleted from the UI, and the primary
 * provider is one settings value that a deleted or disabled provider cannot leave dangling.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import {
  createOAuthProvider,
  deleteOAuthProvider,
  getOAuthProvider,
  getOAuthProviderByName,
  getPrimaryProviderId,
  getProviderDisplayList,
  listEnabledOAuthProviders,
  listOAuthProviders,
  setPrimaryProviderId,
  updateOAuthProvider,
} from '@/src/lib/models/oauth-providers';
import { createLdapDirectory } from '@/src/lib/models/ldap-directories';
import { DomainError } from '@/src/lib/errors/domain-error';
import { oauthProviders, settings } from '../../../src/lib/db/schema';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
}

function provider(name: string, extra: Partial<Parameters<typeof createOAuthProvider>[0]> = {}) {
  return createOAuthProvider({
    name,
    clientId: `${name}-id`,
    clientSecret: `${name}-secret`,
    ...extra,
  });
}

function directory(name = 'Corp') {
  return createLdapDirectory({
    name,
    url: 'ldap://ldap.example.org',
    bindDn: 'cn=admin,dc=example,dc=org',
    bindPassword: 'bind-secret',
    config: { baseDn: 'dc=example,dc=org' },
  });
}

beforeEach(async () => {
  await ctx.db.delete(oauthProviders);
  await ctx.db.delete(settings);
});

describe('createOAuthProvider', () => {
  it('fills the defaults and trims the group mapping', async () => {
    const created = await provider('Keycloak', {
      groupsClaim: '  ',
      groupPrefix: ' kc- ',
      adminGroup: ' admins ',
      operatorGroup: '',
      defaultRole: 'bogus' as never,
    });

    expect(created).toMatchObject({
      type: 'oidc',
      scopes: 'openid email profile',
      autoLink: false,
      enabled: true,
      source: 'ui',
      groupsClaim: 'groups',
      groupPrefix: 'kc-',
      adminGroup: 'admins',
      operatorGroup: null,
      defaultRole: 'user',
      roleMappingEnabled: false,
      syncGroups: false,
    });
  });

  it('refuses to make an LDAP directory', async () => {
    expect(await codeOf(provider('Sneaky', { type: 'ldap' }))).toBe('oauthProviderTypeInvalid');
    expect(await ctx.db.select().from(oauthProviders)).toEqual([]);
  });
});

describe('reading providers', () => {
  it('never answers with an LDAP directory, except by name for the env sync', async () => {
    const ldap = await directory();
    await provider('Keycloak');

    expect((await listOAuthProviders()).map((listed) => listed.name)).toEqual(['Keycloak']);
    expect((await listEnabledOAuthProviders()).map((listed) => listed.name)).toEqual(['Keycloak']);
    expect(await getOAuthProvider(ldap.id)).toBeNull();
    // Otherwise the env sync would insert a clashing name.
    expect((await getOAuthProviderByName('Corp'))?.id).toBe(ldap.id);
    expect(await getOAuthProviderByName('Nobody')).toBeNull();
  });

  it('lists only enabled providers for sign-in, by name', async () => {
    await provider('Zeta');
    await provider('Alpha', { enabled: false });
    await provider('Beta');
    expect((await listEnabledOAuthProviders()).map((listed) => listed.name)).toEqual([
      'Beta',
      'Zeta',
    ]);
  });
});

describe('updateOAuthProvider', () => {
  it('writes each field it is given and nothing else', async () => {
    const created = await provider('Keycloak', { issuer: 'https://id.example.com' });

    const updated = await updateOAuthProvider(created.id, {
      clientId: 'rotated-id',
      authorizationUrl: 'https://id.example.com/auth',
      tokenUrl: 'https://id.example.com/token',
      userinfoUrl: 'https://id.example.com/userinfo',
      scopes: 'openid',
      autoLink: true,
      groupsClaim: ' roles ',
      groupPrefix: ' ',
      roleMappingEnabled: true,
      adminGroup: ' admins ',
      operatorGroup: ' ops ',
      userGroup: ' users ',
      viewerGroup: ' viewers ',
      defaultRole: 'viewer',
      syncGroups: true,
    });

    expect(updated).toMatchObject({
      name: 'Keycloak',
      issuer: 'https://id.example.com',
      clientId: 'rotated-id',
      clientSecret: 'Keycloak-secret',
      authorizationUrl: 'https://id.example.com/auth',
      tokenUrl: 'https://id.example.com/token',
      userinfoUrl: 'https://id.example.com/userinfo',
      scopes: 'openid',
      autoLink: true,
      groupsClaim: 'roles',
      groupPrefix: null,
      roleMappingEnabled: true,
      adminGroup: 'admins',
      operatorGroup: 'ops',
      userGroup: 'users',
      viewerGroup: 'viewers',
      defaultRole: 'viewer',
      syncGroups: true,
    });
  });

  it('falls back on an unknown role and a blank groups claim', async () => {
    const created = await provider('Keycloak', { defaultRole: 'operator' });
    const updated = await updateOAuthProvider(created.id, {
      defaultRole: 'root' as never,
      groupsClaim: '  ',
    });
    expect(updated).toMatchObject({ defaultRole: 'user', groupsClaim: 'groups' });
  });

  it('answers null for a directory or a missing id, and leaves a directory alone', async () => {
    const ldap = await directory();
    expect(await updateOAuthProvider(ldap.id, { name: 'Hijacked' })).toBeNull();
    expect(await updateOAuthProvider('missing', { name: 'x' })).toBeNull();
    expect((await getOAuthProviderByName('Corp'))?.id).toBe(ldap.id);
  });

  it('refuses to turn a provider into a directory', async () => {
    const created = await provider('Keycloak');
    expect(await codeOf(updateOAuthProvider(created.id, { type: 'ldap' }))).toBe(
      'oauthProviderTypeInvalid',
    );
    expect((await getOAuthProvider(created.id))?.type).toBe('oidc');
  });
});

describe('deleteOAuthProvider', () => {
  it('deletes a provider made in the UI', async () => {
    const created = await provider('Keycloak');
    await deleteOAuthProvider(created.id);
    expect(await getOAuthProvider(created.id)).toBeNull();
  });

  it('refuses one the environment defines, and one that does not exist', async () => {
    const fromEnv = await provider('Env', { source: 'env' });
    expect(await codeOf(deleteOAuthProvider(fromEnv.id))).toBe(
      'environmentOAuthProviderDeletionForbidden',
    );
    expect(await getOAuthProvider(fromEnv.id)).not.toBeNull();
    expect(await codeOf(deleteOAuthProvider('missing'))).toBe('oauthProviderNotFound');
  });

  it('cannot delete a directory', async () => {
    const ldap = await directory();
    expect(await codeOf(deleteOAuthProvider(ldap.id))).toBe('oauthProviderNotFound');
  });
});

describe('the primary provider', () => {
  it('is unset until chosen, and can be replaced and cleared', async () => {
    const first = await provider('First');
    const second = await provider('Second');
    expect(await getPrimaryProviderId()).toBeNull();

    await setPrimaryProviderId(first.id);
    await setPrimaryProviderId(second.id);
    expect(await getPrimaryProviderId()).toBe(second.id);
    // One settings row: two primaries cannot be represented.
    expect(await ctx.db.select().from(settings)).toHaveLength(1);

    await setPrimaryProviderId(null);
    expect(await getPrimaryProviderId()).toBeNull();
  });

  it('is offered first, the rest alphabetically, with no directories or disabled ones', async () => {
    await provider('Alpha', { autoLink: true });
    const zeta = await provider('Zeta');
    await provider('Off', { enabled: false });
    await directory();
    await setPrimaryProviderId(zeta.id);

    expect(await getProviderDisplayList()).toEqual([
      { id: zeta.id, name: 'Zeta', autoLink: false, isPrimary: true, protocol: 'oidc' },
      expect.objectContaining({ name: 'Alpha', autoLink: true, isPrimary: false }),
    ]);
  });

  it('marks nothing when the chosen provider is disabled', async () => {
    const chosen = await provider('Chosen');
    await provider('Other');
    await setPrimaryProviderId(chosen.id);
    await updateOAuthProvider(chosen.id, { enabled: false });

    const list = await getProviderDisplayList();
    expect(list.map((entry) => [entry.name, entry.isPrimary])).toEqual([['Other', false]]);
  });
});
