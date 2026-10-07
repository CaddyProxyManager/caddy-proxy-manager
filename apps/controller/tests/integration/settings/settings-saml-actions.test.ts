/**
 * Settings -> Authentication: SAML providers through their server actions, and the single sign-on
 * enforcement block, against a real database. Changes are audited and only administrators get
 * anywhere; enforcement is staged like the rest of the page.
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
  createSamlProviderAction,
  deleteSamlProviderAction,
  updateSamlProviderAction,
} from '@/src/app/(dashboard)/settings/saml-actions';
import { updateSsoEnforcementSettingsAction } from '@/src/app/(dashboard)/settings/actions';
import { domainErrorMessage } from '@/src/lib/errors/domain-error';
import { getSamlProvider } from '@/src/lib/models/saml-providers';
import { auditEvents, oauthProviders, ssoProviders } from '@/src/lib/db/schema';
import { createTestIdp } from '@/tests/helpers/saml-idp';
import { type SessionUser, form, seedUser, stagedSetting } from '../../helpers/settings-actions';

let admin: SessionUser;
const idp = createTestIdp('https://idp.example.com/realms/cpm');

async function audit() {
  const rows = await ctx.db.select().from(auditEvents).orderBy(auditEvents.id);
  return rows.map((row) => ({
    action: row.action,
    entityType: row.entityType,
    summary: row.summary,
  }));
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  admin = await seedUser(ctx.db, 'admin@example.com', 'admin');
  ctx.session = { user: admin };
});

describe('SAML providers', () => {
  it('creates, edits and deletes a provider, auditing each', async () => {
    const created = await createSamlProviderAction({
      name: 'Keycloak SAML',
      metadataXml: idp.metadata(),
      linkDomains: 'example.com',
      roleMappingEnabled: true,
      adminGroup: 'cpm-admins',
    });
    expect(created).toMatchObject({
      name: 'Keycloak SAML',
      enabled: true,
      idpEntityId: 'https://idp.example.com/realms/cpm',
      certificateCount: 1,
      linkDomains: 'example.com',
      adminGroup: 'cpm-admins',
    });
    expect(created.spEntityId).toContain(`providerId=${created.id}`);
    const [row] = await ctx.db
      .select()
      .from(oauthProviders)
      .where(eq(oauthProviders.id, created.id));
    expect(row).toMatchObject({ type: 'saml', autoLink: true });
    const [plugin] = await ctx.db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.providerId, created.id));
    expect(JSON.parse(plugin.samlConfig ?? '{}')).toMatchObject({
      issuer: created.spEntityId,
      wantAssertionsSigned: true,
      entryPoint: 'https://idp.example.com/realms/cpm/protocol/saml',
    });

    const disabled = await updateSamlProviderAction(created.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    // A switch alone keeps the stored metadata and attributes.
    expect(disabled.metadataXml).toBe(created.metadataXml);

    await deleteSamlProviderAction(created.id);
    expect(await getSamlProvider(created.id)).toBeNull();
    expect(await ctx.db.select().from(ssoProviders)).toHaveLength(0);

    expect(await audit()).toEqual([
      {
        action: 'create',
        entityType: 'saml_provider',
        summary: 'Created SAML provider Keycloak SAML',
      },
      {
        action: 'update',
        entityType: 'saml_provider',
        summary: 'Updated SAML provider Keycloak SAML',
      },
      {
        action: 'delete',
        entityType: 'saml_provider',
        summary: 'Deleted SAML provider Keycloak SAML',
      },
    ]);
  });

  it("says why bad metadata, a clashing name or a bad domain is refused, in the reader's words", async () => {
    const attempt = async (input: Parameters<typeof createSamlProviderAction>[0]) => {
      try {
        await createSamlProviderAction(input);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await attempt({ name: 'Broken', metadataXml: '<nope/>' })).toBe(
      domainErrorMessage('samlMetadataInvalid'),
    );
    expect(await attempt({ name: 'No metadata' })).toBe(domainErrorMessage('samlMetadataRequired'));
    expect(
      await attempt({
        name: 'Bad domain',
        metadataXml: idp.metadata(),
        linkDomains: 'not a domain',
      }),
    ).toBe(domainErrorMessage('samlLinkDomainInvalid', { domain: 'not a domain' }));
    await createSamlProviderAction({ name: 'Taken', metadataXml: idp.metadata() });
    expect(await attempt({ name: 'Taken', metadataXml: idp.metadata() })).toBe(
      domainErrorMessage('ldapDirectoryNameTaken', { name: 'Taken' }),
    );
  });

  it('lets only administrators manage providers', async () => {
    ctx.session = { user: await seedUser(ctx.db, 'viewer@example.com', 'viewer') };
    let refused = false;
    try {
      await createSamlProviderAction({ name: 'Nope', metadataXml: idp.metadata() });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(await ctx.db.select().from(oauthProviders)).toHaveLength(0);
  });
});

describe('single sign-on enforcement', () => {
  it('stages the policy for the operator to apply', async () => {
    await createSamlProviderAction({ name: 'Keycloak SAML', metadataXml: idp.metadata() });
    const result = await updateSsoEnforcementSettingsAction(
      null,
      form({ enforced: 'true', allowLdap: 'false', breakGlassUserIds: admin.id }),
    );
    expect(result.success).toBe(true);
    expect(await stagedSetting(ctx.db, admin.id, 'sso_enforcement')).toEqual({
      enforced: true,
      breakGlassUserIds: [Number(admin.id)],
      allowLdap: false,
    });
  });

  it('refuses enforcing with no provider enabled', async () => {
    const result = await updateSsoEnforcementSettingsAction(
      null,
      form({ enforced: 'true', allowLdap: 'true', breakGlassUserIds: '' }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe(domainErrorMessage('ssoEnforcementNeedsProvider'));
    expect(await stagedSetting(ctx.db, admin.id, 'sso_enforcement')).toBeUndefined();
  });
});
