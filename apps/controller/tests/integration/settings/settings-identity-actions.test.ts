/**
 * Settings -> Authentication: OAuth providers and LDAP directories, created, edited and deleted
 * through their server actions against a real database. Each change is audited, the auth instance
 * forgets its cached providers, secrets never come back to the browser, and only administrators
 * get anywhere.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  session: null as null | { user: import('../../helpers/settings-actions').SessionUser },
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

import { eq } from 'drizzle-orm';
import {
  createOAuthProviderAction,
  deleteOAuthProviderAction,
  getOAuthProvidersAction,
  setPrimaryOAuthProviderAction,
  updateOAuthProviderAction,
} from '@/src/app/(dashboard)/settings/actions';
import {
  createLdapDirectoryAction,
  deleteLdapDirectoryAction,
  setLdapDirectoryEnabledAction,
  testLdapDirectoryAction,
  updateLdapDirectoryAction,
} from '@/src/app/(dashboard)/settings/ldap-actions';
import { unwrap } from '@/src/lib/errors/action-result';
import { domainErrorMessage } from '@/src/lib/errors/domain-error';
import { DEFAULT_LDAP_CONFIG } from '@/src/lib/ldap/defaults';
import { getLdapDirectory } from '@/src/lib/models/ldap-directories';
import { getOAuthProvider, getPrimaryProviderId } from '@/src/lib/models/oauth-providers';
import { auditEvents, oauthProviders } from '@/src/lib/db/schema';
import { testTranslator } from '../../helpers/next-intl';
import { type SessionUser, seedUser } from '../../helpers/settings-actions';

const ADMIN_REQUIRED = domainErrorMessage('accessDenied');

let admin: SessionUser;

async function audit() {
  const rows = await ctx.db.select().from(auditEvents).orderBy(auditEvents.id);
  return rows.map((row) => ({
    userId: row.userId,
    action: row.action,
    entityType: row.entityType,
    summary: row.summary,
    data: row.data ? JSON.parse(row.data) : null,
  }));
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  admin = await seedUser(ctx.db, 'admin@example.com', 'admin');
  ctx.session = { user: admin };
});

describe('OAuth providers', () => {
  const INPUT = {
    name: 'Keycloak',
    type: 'oidc',
    clientId: 'cpm',
    clientSecret: 'client-secret',
    issuer: 'https://id.example.com/realms/main',
  };

  it('creates a provider, returns it without its secret, and audits it', async () => {
    const view = unwrap(await createOAuthProviderAction(INPUT));

    expect(view).toMatchObject({
      name: 'Keycloak',
      clientId: 'cpm',
      hasClientSecret: true,
      source: 'ui',
    });
    expect(view).not.toHaveProperty('clientSecret');
    expect((await getOAuthProvider(view.id))?.clientSecret).toBe('client-secret');
    expect(await audit()).toEqual([
      {
        userId: Number(admin.id),
        action: 'oauth_provider_created',
        entityType: 'oauth_provider',
        summary: 'OAuth provider "Keycloak" created',
        data: { providerId: view.id },
      },
    ]);
    expect(unwrap(await getOAuthProvidersAction()).map((provider) => provider.id)).toEqual([
      view.id,
    ]);
  });

  it('updates only the fields given, and audits which', async () => {
    const { id } = unwrap(await createOAuthProviderAction(INPUT));

    const view = unwrap(
      await updateOAuthProviderAction(id, { enabled: false, scopes: 'openid email' }),
    );

    expect(view).toMatchObject({ enabled: false, scopes: 'openid email', name: 'Keycloak' });
    expect((await audit()).at(-1)).toMatchObject({
      action: 'oauth_provider_updated',
      data: { providerId: id, fields: ['enabled', 'scopes'] },
    });
  });

  it('answers null for a provider that does not exist', async () => {
    expect(unwrap(await updateOAuthProviderAction('missing', { enabled: false }))).toBeNull();
  });

  it('refuses to turn a provider into an LDAP directory', async () => {
    expect(await createOAuthProviderAction({ ...INPUT, type: 'ldap' })).toEqual({
      ok: false,
      error: domainErrorMessage('oauthProviderTypeInvalid'),
    });
    expect(await ctx.db.select().from(oauthProviders)).toEqual([]);
  });

  it('records the primary provider, and clears it', async () => {
    const { id } = unwrap(await createOAuthProviderAction(INPUT));

    unwrap(await setPrimaryOAuthProviderAction(id));
    expect(await getPrimaryProviderId()).toBe(id);
    unwrap(await setPrimaryOAuthProviderAction(null));
    expect(await getPrimaryProviderId()).toBeNull();

    expect((await audit()).slice(-2).map((event) => event.summary)).toEqual([
      `Made OAuth provider "${id}" primary`,
      'Cleared the primary OAuth provider',
    ]);
  });

  it('deletes a provider by name in the audit trail', async () => {
    const { id } = unwrap(await createOAuthProviderAction(INPUT));

    unwrap(await deleteOAuthProviderAction(id));

    expect(await getOAuthProvider(id)).toBeNull();
    expect((await audit()).at(-1)).toMatchObject({
      action: 'oauth_provider_deleted',
      summary: 'Deleted OAuth provider "Keycloak"',
    });
  });

  it('refuses to delete a provider the environment defines', async () => {
    const { id } = unwrap(await createOAuthProviderAction(INPUT));
    await ctx.db.update(oauthProviders).set({ source: 'env' }).where(eq(oauthProviders.id, id));

    expect(await deleteOAuthProviderAction(id)).toEqual({
      ok: false,
      error: domainErrorMessage('environmentOAuthProviderDeletionForbidden'),
    });
    expect(await getOAuthProvider(id)).not.toBeNull();
  });
});

describe('LDAP directories', () => {
  const INPUT = {
    name: 'Corp LDAP',
    url: 'ldap://ldap.example.com',
    bindDn: 'cn=svc,dc=example,dc=org',
    bindPassword: 'bind-secret',
    config: { ...DEFAULT_LDAP_CONFIG, baseDn: 'dc=example,dc=org' },
  };

  it('creates a directory, keeps its bind password write-only, and audits it', async () => {
    const view = await createLdapDirectoryAction(INPUT).then(unwrap);

    expect(view).toMatchObject({ name: 'Corp LDAP', hasBindPassword: true, enabled: true });
    expect(view).not.toHaveProperty('bindPassword');
    expect((await getLdapDirectory(view.id))?.bindPassword).toBe('bind-secret');
    expect(await audit()).toEqual([
      {
        userId: Number(admin.id),
        action: 'create',
        entityType: 'ldap_directory',
        summary: 'Created directory Corp LDAP',
        data: { directoryId: view.id },
      },
    ]);
  });

  it('keeps the stored bind password across an edit that leaves it blank', async () => {
    const { id } = await createLdapDirectoryAction(INPUT).then(unwrap);

    const view = await updateLdapDirectoryAction(id, {
      ...INPUT,
      name: 'Corporate LDAP',
      bindPassword: '',
    }).then(unwrap);

    expect(view.name).toBe('Corporate LDAP');
    expect((await getLdapDirectory(id))?.bindPassword).toBe('bind-secret');
    expect((await audit()).at(-1)).toMatchObject({
      action: 'update',
      summary: 'Updated directory Corporate LDAP',
    });
  });

  it('will not send the stored password to a new address', async () => {
    const { id } = await createLdapDirectoryAction(INPUT).then(unwrap);

    expect(
      await updateLdapDirectoryAction(id, {
        ...INPUT,
        url: 'ldap://attacker.test',
        bindPassword: '',
      }),
    ).toEqual({ ok: false, error: domainErrorMessage('ldapBindPasswordReentry') });
    expect((await getLdapDirectory(id))?.url).toBe('ldap://ldap.example.com');
  });

  it("refuses a second directory with the same name, in the reader's words", async () => {
    await createLdapDirectoryAction(INPUT).then(unwrap);

    expect(await createLdapDirectoryAction(INPUT)).toEqual({
      ok: false,
      error: domainErrorMessage('ldapDirectoryNameTaken', { name: 'Corp LDAP' }),
    });
  });

  it('switches a directory off and on', async () => {
    const { id } = await createLdapDirectoryAction(INPUT).then(unwrap);

    expect((await setLdapDirectoryEnabledAction(id, false).then(unwrap)).enabled).toBe(false);
    expect((await getLdapDirectory(id))?.enabled).toBe(false);
    expect((await setLdapDirectoryEnabledAction(id, true).then(unwrap)).enabled).toBe(true);
  });

  it('deletes a directory and audits it by name', async () => {
    const { id } = await createLdapDirectoryAction(INPUT).then(unwrap);

    await deleteLdapDirectoryAction(id).then(unwrap);

    expect(await getLdapDirectory(id)).toBeNull();
    expect((await audit()).at(-1)).toMatchObject({
      action: 'delete',
      summary: 'Deleted directory Corp LDAP',
    });
  });

  it('says a missing directory is missing', async () => {
    const missing = { ok: false as const, error: domainErrorMessage('ldapDirectoryNotFound') };
    expect(await setLdapDirectoryEnabledAction('missing', true)).toEqual(missing);
    expect(await deleteLdapDirectoryAction('missing')).toEqual(missing);
    expect(await updateLdapDirectoryAction('missing', INPUT)).toEqual(missing);
  });

  it('tests an unsaved form and says the connection failed', async () => {
    const result = await testLdapDirectoryAction({ ...INPUT, url: 'ldap://127.0.0.1:1' }, null, {
      username: '  ',
      password: 'ignored without a username',
    }).then(unwrap);

    expect(result).toMatchObject({
      ok: false,
      message: testTranslator('settings.ldap.test')('stage.connect'),
      identity: null,
    });
    expect(result.detail).toBeTruthy();
    expect(await ctx.db.select().from(oauthProviders)).toEqual([]);
  });

  it('refuses to test a form that could not be saved', async () => {
    expect(await testLdapDirectoryAction({ ...INPUT, name: ' ' }, null, null)).toEqual({
      ok: false,
      error: domainErrorMessage('ldapNameRequired'),
    });
  });
});

describe('a non-administrator', () => {
  it('can neither read nor change providers or directories', async () => {
    const provider = unwrap(
      await createOAuthProviderAction({
        name: 'Keycloak',
        type: 'oidc',
        clientId: 'cpm',
        clientSecret: 'secret',
      }),
    );
    ctx.session = { user: await seedUser(ctx.db, 'op@example.com', 'operator') };
    const directory = {
      name: 'X',
      url: 'ldap://x.test',
      config: { ...DEFAULT_LDAP_CONFIG, baseDn: 'dc=x' },
    };

    const attempts = [
      () => getOAuthProvidersAction().then(unwrap),
      () =>
        createOAuthProviderAction({
          name: 'X',
          type: 'oidc',
          clientId: 'x',
          clientSecret: 'x',
        }).then(unwrap),
      () => updateOAuthProviderAction(provider.id, { enabled: false }).then(unwrap),
      () => deleteOAuthProviderAction(provider.id).then(unwrap),
      () => setPrimaryOAuthProviderAction(provider.id).then(unwrap),
      () => createLdapDirectoryAction(directory).then(unwrap),
      () => updateLdapDirectoryAction('any', directory).then(unwrap),
      () => setLdapDirectoryEnabledAction('any', false).then(unwrap),
      () => deleteLdapDirectoryAction('any').then(unwrap),
      () => testLdapDirectoryAction(directory, null, null).then(unwrap),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow(ADMIN_REQUIRED);

    expect((await getOAuthProvider(provider.id))?.enabled).toBe(true);
    expect(await ctx.db.select().from(oauthProviders)).toHaveLength(1);
  });
});
