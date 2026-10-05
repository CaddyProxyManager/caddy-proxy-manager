/**
 * LDAP directories as a model, against a real database: they share `oauth_providers` with OIDC but
 * stay apart from it, the bind password is write-only and only ever goes where it was saved for,
 * and an unusable combination is refused whole.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import {
  createLdapDirectory,
  getLdapDirectory,
  hasDirectoryAccount,
  type LdapDirectoryInput,
  ldapDirectoryNames,
  listEnabledLdapDirectories,
  listLdapDirectories,
  listLdapDirectoryChoices,
  previewLdapDirectory,
  setLdapDirectoryEnabled,
  updateLdapDirectory,
} from '@/src/lib/models/ldap-directories';
import { createOAuthProvider, listOAuthProviders } from '@/src/lib/models/oauth-providers';
import { DomainError } from '@/src/lib/errors/domain-error';
import { isEncryptedSecret } from '@/src/lib/secrets';
import { accounts, oauthProviders, users } from '../../../src/lib/db/schema';

const NOW = '2026-03-01T00:00:00.000Z';
const BIND_DN = 'cn=admin,dc=example,dc=org';

function input(overrides: Partial<LdapDirectoryInput> = {}): LdapDirectoryInput {
  return {
    name: 'Corp',
    url: 'ldap://ldap.example.org',
    bindDn: BIND_DN,
    bindPassword: 'bind-secret',
    config: { baseDn: 'dc=example,dc=org' },
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
}

beforeEach(async () => {
  await ctx.db.delete(accounts);
  await ctx.db.delete(oauthProviders);
  await ctx.db.delete(users);
});

describe('createLdapDirectory', () => {
  it('stores the URL rebuilt, the bind credentials sealed and the config normalized', async () => {
    const directory = await createLdapDirectory(
      input({
        name: '  Corp  ',
        url: ' ldap://ldap.example.org:389/ ',
        roleMappingEnabled: true,
        adminGroup: '  Proxy Admins ',
        viewerGroup: '   ',
        defaultRole: 'nonsense' as never,
      }),
    );

    expect(directory).toMatchObject({
      name: 'Corp',
      url: 'ldap://ldap.example.org:389',
      bindDn: BIND_DN,
      bindPassword: 'bind-secret',
      enabled: true,
      autoLink: false,
      groupsClaim: 'memberOf',
      roleMappingEnabled: true,
      adminGroup: 'Proxy Admins',
      viewerGroup: null,
      defaultRole: 'user',
    });
    expect(directory.config).toMatchObject({
      baseDn: 'dc=example,dc=org',
      groupSource: 'memberOf',
    });

    const [row] = await ctx.db
      .select()
      .from(oauthProviders)
      .where(eq(oauthProviders.id, directory.id));
    expect(row.type).toBe('ldap');
    expect(isEncryptedSecret(row.clientId)).toBe(true);
    expect(isEncryptedSecret(row.clientSecret)).toBe(true);
  });

  it('stores no service credentials for a directory that binds as the user', async () => {
    const directory = await createLdapDirectory(
      input({
        url: 'ldaps://ldap.example.org',
        config: { baseDn: 'dc=example,dc=org', userDnTemplate: 'uid={username},dc=example,dc=org' },
      }),
    );
    expect(directory.bindDn).toBe('');
    expect(directory.bindPassword).toBe('');
  });

  it.each([
    [{ name: '   ' }, 'ldapNameRequired'],
    [{ url: 'http://ldap.example.org' }, 'ldapUrlInvalid'],
    [{ config: { baseDn: '' } }, 'ldapBaseDnRequired'],
    [{ bindPassword: '' }, 'ldapBindPasswordRequired'],
  ] as const)('refuses %p and stores nothing', async (overrides, code) => {
    expect(await codeOf(createLdapDirectory(input(overrides)))).toBe(code);
    expect(await ctx.db.select().from(oauthProviders)).toEqual([]);
  });

  it('refuses a name an OIDC provider already has', async () => {
    await createOAuthProvider({ name: 'Corp', clientId: 'id', clientSecret: 'secret' });
    expect(await codeOf(createLdapDirectory(input()))).toBe('ldapDirectoryNameTaken');
  });
});

describe('reading directories', () => {
  it('keeps OIDC providers and directories out of each other lists', async () => {
    await createOAuthProvider({ name: 'Keycloak', clientId: 'id', clientSecret: 'secret' });
    const directory = await createLdapDirectory(input());

    expect((await listOAuthProviders()).map((provider) => provider.name)).toEqual(['Keycloak']);
    expect((await listLdapDirectories()).map((listed) => listed.name)).toEqual(['Corp']);
    expect(await ldapDirectoryNames()).toEqual(new Map([[directory.id, 'Corp']]));
  });

  it('never lists the bind password, only whether there is one', async () => {
    await createLdapDirectory(input());
    const [view] = await listLdapDirectories();
    expect(view).not.toHaveProperty('bindPassword');
    expect(view.hasBindPassword).toBe(true);
  });

  it('offers only enabled directories for sign-in, by name', async () => {
    const zeta = await createLdapDirectory(input({ name: 'Zeta' }));
    await createLdapDirectory(input({ name: 'Alpha', enabled: false }));
    const beta = await createLdapDirectory(input({ name: 'Beta' }));

    expect(await listLdapDirectoryChoices()).toEqual([
      { id: beta.id, name: 'Beta' },
      { id: zeta.id, name: 'Zeta' },
    ]);
    expect((await listEnabledLdapDirectories())[0].bindPassword).toBe('bind-secret');
  });

  it('answers null for an id that is not a directory', async () => {
    const oidc = await createOAuthProvider({ name: 'Keycloak', clientId: 'id', clientSecret: 's' });
    expect(await getLdapDirectory(oidc.id)).toBeNull();
    expect(await getLdapDirectory('missing')).toBeNull();
  });

  it("tells a directory's account from any other", async () => {
    const directory = await createLdapDirectory(input());
    const oidc = await createOAuthProvider({ name: 'Keycloak', clientId: 'id', clientSecret: 's' });
    const [alice, bob] = await ctx.db
      .insert(users)
      .values([
        { email: 'alice@example.com', createdAt: NOW, updatedAt: NOW },
        { email: 'bob@example.com', createdAt: NOW, updatedAt: NOW },
      ])
      .returning({ id: users.id });
    await ctx.db.insert(accounts).values([
      {
        userId: alice.id,
        providerId: directory.id,
        accountId: 'alice',
        createdAt: NOW,
        updatedAt: NOW,
      },
      { userId: bob.id, providerId: oidc.id, accountId: 'bob', createdAt: NOW, updatedAt: NOW },
    ]);

    expect(await hasDirectoryAccount(alice.id)).toBe(true);
    expect(await hasDirectoryAccount(bob.id)).toBe(false);
  });
});

describe('updateLdapDirectory', () => {
  it('keeps the stored password when the form leaves it blank', async () => {
    const directory = await createLdapDirectory(input());

    const updated = await updateLdapDirectory(
      directory.id,
      input({ name: 'Corp HQ', bindPassword: '', autoLink: true, syncGroups: true }),
    );

    expect(updated).toMatchObject({
      name: 'Corp HQ',
      bindPassword: 'bind-secret',
      autoLink: true,
      syncGroups: true,
    });
  });

  it('merges a partial config over the stored one', async () => {
    const directory = await createLdapDirectory(
      input({ config: { baseDn: 'dc=example,dc=org', emailAttribute: 'userPrincipalName' } }),
    );
    const updated = await updateLdapDirectory(
      directory.id,
      input({ bindPassword: '', config: { nameAttribute: 'cn' } }),
    );
    expect(updated.config).toMatchObject({
      baseDn: 'dc=example,dc=org',
      emailAttribute: 'userPrincipalName',
      nameAttribute: 'cn',
    });
  });

  it('asks for the password again before sending it to a new address or as a new DN', async () => {
    const directory = await createLdapDirectory(input());

    for (const change of [
      { url: 'ldap://attacker.example.net' },
      { bindDn: 'cn=someone-else,dc=example,dc=org' },
    ]) {
      expect(
        await codeOf(updateLdapDirectory(directory.id, input({ ...change, bindPassword: '' }))),
      ).toBe('ldapBindPasswordReentry');
    }
    const stored = await getLdapDirectory(directory.id);
    expect(stored).toMatchObject({ url: 'ldap://ldap.example.org', bindDn: BIND_DN });

    const moved = await updateLdapDirectory(
      directory.id,
      input({ url: 'ldap://ldap2.example.org', bindPassword: 'retyped' }),
    );
    expect(moved).toMatchObject({ url: 'ldap://ldap2.example.org', bindPassword: 'retyped' });
  });

  it("refuses another directory's name and a directory that does not exist", async () => {
    await createLdapDirectory(input({ name: 'Taken' }));
    const directory = await createLdapDirectory(input());

    expect(await codeOf(updateLdapDirectory(directory.id, input({ name: 'Taken' })))).toBe(
      'ldapDirectoryNameTaken',
    );
    expect(await codeOf(updateLdapDirectory('missing', input()))).toBe('ldapDirectoryNotFound');
  });

  it('keeps its own name', async () => {
    const directory = await createLdapDirectory(input());
    expect((await updateLdapDirectory(directory.id, input())).name).toBe('Corp');
  });
});

describe('setLdapDirectoryEnabled', () => {
  it('turns a directory off and on', async () => {
    const directory = await createLdapDirectory(input());
    expect((await setLdapDirectoryEnabled(directory.id, false)).enabled).toBe(false);
    expect(await listLdapDirectoryChoices()).toEqual([]);
    expect((await setLdapDirectoryEnabled(directory.id, true)).enabled).toBe(true);
  });

  it('refuses an OIDC provider and a missing id alike', async () => {
    const oidc = await createOAuthProvider({ name: 'Keycloak', clientId: 'id', clientSecret: 's' });
    expect(await codeOf(setLdapDirectoryEnabled(oidc.id, false))).toBe('ldapDirectoryNotFound');
    expect(await codeOf(setLdapDirectoryEnabled('missing', false))).toBe('ldapDirectoryNotFound');
  });
});

describe('previewLdapDirectory', () => {
  it('builds an unsaved directory from a new form', async () => {
    const preview = await previewLdapDirectory(
      input({ groupPrefix: ' ldap- ', roleMappingEnabled: true, defaultRole: 'viewer' }),
      null,
    );

    expect(preview).toMatchObject({
      id: 'preview',
      bindPassword: 'bind-secret',
      groupPrefix: 'ldap-',
      roleMappingEnabled: true,
      defaultRole: 'viewer',
      enabled: true,
    });
    expect(await ctx.db.select().from(oauthProviders)).toEqual([]);
  });

  it("tests an existing directory with its stored password when the form's is blank", async () => {
    const directory = await createLdapDirectory(input());
    const preview = await previewLdapDirectory(input({ bindPassword: '' }), directory.id);
    expect(preview).toMatchObject({ id: directory.id, bindPassword: 'bind-secret' });
  });

  it('never tests the stored password against a new address', async () => {
    const directory = await createLdapDirectory(input());
    expect(
      await codeOf(
        previewLdapDirectory(
          input({ url: 'ldap://elsewhere.example', bindPassword: '' }),
          directory.id,
        ),
      ),
    ).toBe('ldapBindPasswordReentry');
  });

  it('drops the service credentials for a directory that binds as the user', async () => {
    const preview = await previewLdapDirectory(
      input({
        url: 'ldaps://ldap.example.org',
        config: { baseDn: 'dc=example,dc=org', userDnTemplate: 'uid={username},dc=example,dc=org' },
      }),
      null,
    );
    expect([preview.bindDn, preview.bindPassword]).toEqual(['', '']);
  });

  it('refuses an id that does not exist', async () => {
    expect(await codeOf(previewLdapDirectory(input(), 'missing'))).toBe('ldapDirectoryNotFound');
  });
});
