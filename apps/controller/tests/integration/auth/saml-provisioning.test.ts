/**
 * What a SAML sign-in does to the account: groups and role from the assertion's groups attribute
 * on the first sign-in and every later one, linking by email domain, the registration setting,
 * and which of the plugin's routes stay reachable.
 */
import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { vi } from '@/tests/helpers/vi';
import { CookieJar, bootSaml, outcome, registerSamlCleanup } from '@/tests/helpers/saml-harness';
import { signedResponse } from '@/tests/helpers/saml-idp';

vi.mock('next-intl/server', () => nextIntlServerMock());
registerSamlCleanup();

const REGISTRATION = { AUTH_ALLOW_OAUTH_REGISTRATION: 'true' };
const EMAIL = 'saml.user@example.com';

type Harness = Awaited<ReturnType<typeof bootSaml>>;

async function userOf(h: Harness) {
  const [user] = await h.db.select().from(h.schema.users).where(eq(h.schema.users.email, EMAIL));
  return user;
}

async function groupNamesOf(h: Harness, userId: number) {
  const rows = await h.db
    .select({ name: h.schema.groups.name })
    .from(h.schema.groupMembers)
    .innerJoin(h.schema.groups, eq(h.schema.groups.id, h.schema.groupMembers.groupId))
    .where(eq(h.schema.groupMembers.userId, userId));
  return rows.map((row: { name: string }) => row.name).sort();
}

async function madeRole(h: Harness, key: string) {
  const now = new Date().toISOString();
  await h.db.insert(h.schema.roles).values({
    key,
    name: 'Operations',
    capabilities: JSON.stringify(['proxy-hosts:read']),
    createdAt: now,
    updatedAt: now,
  });
}

describe('group and role mapping', () => {
  it('maps groups and a custom role on the first sign-in and keeps them in step later', async () => {
    const h = await bootSaml({ env: REGISTRATION });
    await madeRole(h, 'role-ops');
    // Another admin, or demoting the SAML user would be refused as the last one.
    const users = await import('@/src/lib/models/user');
    await users.createUser({
      email: 'owner@example.com',
      provider: 'credentials',
      subject: 'owner@example.com',
      role: 'admin',
    });
    await h.samlModel.updateSamlProvider(h.provider.id, {
      groupsClaim: 'memberOf',
      roleMappingEnabled: true,
      roleGroups: { admin: ['cpm-admins'], 'role-ops': ['/Platform/ops'] },
      defaultRole: 'viewer',
      syncGroups: true,
      groupPrefix: 'cpm-',
    });

    const first = await h.signIn({
      attributes: { email: EMAIL, memberOf: ['/Platform/ops', 'cpm-staging'] },
    });
    expect(outcome(first.response).error).toBeNull();
    let user = await userOf(h);
    expect(user.role).toBe('role-ops');
    expect(await groupNamesOf(h, user.id)).toEqual(['staging']);

    const second = await h.signIn({
      attributes: { email: EMAIL, memberOf: ['cpm-admins', 'cpm-production'] },
    });
    expect(outcome(second.response).error).toBeNull();
    user = await userOf(h);
    expect(user.role).toBe('admin');
    expect(await groupNamesOf(h, user.id)).toEqual(['production']);

    // A sole value arrives as a string, not a list.
    const third = await h.signIn({ attributes: { email: EMAIL, memberOf: 'unrelated' } });
    expect(outcome(third.response).error).toBeNull();
    user = await userOf(h);
    expect(user.role).toBe('viewer');
    expect(await groupNamesOf(h, user.id)).toEqual([]);
  });

  it('leaves the role alone when role mapping is off', async () => {
    const h = await bootSaml({ env: REGISTRATION });
    await h.signIn({ attributes: { email: EMAIL, groups: ['cpm-admins'] } });
    const user = await userOf(h);
    expect(user.role).toBe('user');
  });

  it('never takes a role from an attribute named like a user column', async () => {
    const h = await bootSaml({ env: REGISTRATION });
    await h.signIn({ attributes: { email: EMAIL, role: 'admin', status: 'active' } });
    expect((await userOf(h)).role).toBe('user');
  });
});

describe('accounts that already exist', () => {
  async function localUser() {
    const users = await import('@/src/lib/models/user');
    return users.createUser({ email: EMAIL, provider: 'credentials', subject: EMAIL });
  }

  it('does not join an existing account unless its email domain is one the provider links', async () => {
    const h = await bootSaml({ env: REGISTRATION });
    await localUser();
    const refused = await h.signIn();
    expect(outcome(refused.response).error).toBe('account_not_linked');
    expect(refused.jar.has('session_token')).toBe(false);
  });

  it('joins the existing account when the provider links its domain', async () => {
    const h = await bootSaml({ env: REGISTRATION, provider: { linkDomains: 'Example.com' } });
    const local = await localUser();
    const { response, jar } = await h.signIn();
    expect(outcome(response).error).toBeNull();
    expect(jar.has('session_token')).toBe(true);
    const accounts = await h.db
      .select()
      .from(h.schema.accounts)
      .where(eq(h.schema.accounts.providerId, h.provider.id));
    expect(accounts.map((row: { userId: number }) => row.userId)).toEqual([local.id]);
  });
});

describe('registration', () => {
  it('creates no account while provider registration is off, even when asked to', async () => {
    const h = await bootSaml();
    const jar = new CookieJar();
    const started = await h.call(jar, 'POST', '/sign-in/sso', {
      providerId: h.provider.id,
      callbackURL: '/',
      requestSignUp: true,
    });
    const { url } = await started.json();
    const { readAuthnRequest } = await import('@/tests/helpers/saml-idp');
    const request = readAuthnRequest(url);
    const response = await h.post(
      jar,
      signedResponse(h.idp, h.responseFor(request.id)),
      request.relayState,
    );
    expect(outcome(response).error).toBe('signup_disabled');
    expect(await userOf(h)).toBeUndefined();
  });
});

describe('which plugin routes answer', () => {
  it('starts a sign-in only by provider id, and only for an enabled SAML provider', async () => {
    const h = await bootSaml({ env: REGISTRATION });
    const jar = new CookieJar();
    const byEmail = await h.call(jar, 'POST', '/sign-in/sso', {
      email: 'someone@example.com',
      callbackURL: '/',
    });
    expect(byEmail.status).toBe(404);
    const unknown = await h.call(jar, 'POST', '/sign-in/sso', {
      providerId: 'nope',
      callbackURL: '/',
    });
    expect(unknown.status).toBe(404);

    const started = await h.start();
    await h.samlModel.updateSamlProvider(h.provider.id, { enabled: false });
    expect((await h.start()).response.status).toBe(404);
    // A response for a sign-in begun before it was switched off is refused too.
    const late = await h.post(
      started.jar,
      signedResponse(h.idp, h.responseFor(started.request?.id ?? null)),
      started.request?.relayState ?? null,
    );
    expect(late.status).toBe(404);
    expect(started.jar.has('session_token')).toBe(false);
  });

  it('refuses every route that would manage providers or take another protocol', async () => {
    const h = await bootSaml({ env: REGISTRATION });
    const users = await import('@/src/lib/models/user');
    const { hashPassword } = await import('@/src/lib/auth/password');
    await users.createUser({
      email: 'admin@example.com',
      provider: 'credentials',
      subject: 'admin@example.com',
      passwordHash: await hashPassword('Admin-password-2026!'),
      role: 'admin',
    });
    const jar = new CookieJar();
    const signedIn = await h.call(jar, 'POST', '/sign-in/username', {
      username: 'admin@example.com',
      password: 'Admin-password-2026!',
    });
    expect(signedIn.status).toBe(200);

    for (const [method, path] of [
      ['POST', '/sso/register'],
      ['GET', '/sso/providers'],
      ['GET', `/sso/get-provider?providerId=${h.provider.id}`],
      ['POST', '/sso/update-provider'],
      ['POST', '/sso/delete-provider'],
      ['POST', '/sso/request-domain-verification'],
      ['POST', '/sso/verify-domain'],
      ['GET', `/sso/callback/${h.provider.id}`],
      ['POST', `/sso/saml2/sp/slo/${h.provider.id}`],
      ['GET', `/sso/saml2/logout/${h.provider.id}`],
    ] as const) {
      const response = await h.call(jar, method, path, method === 'POST' ? {} : undefined);
      expect([path, response.status]).toEqual([path, 404]);
    }
    const rows = await h.db.select().from(h.schema.ssoProviders);
    expect(rows).toHaveLength(1);
  });
});
