/**
 * Enforced single sign-on through Better Auth's real routes: passwords and passkeys refused except
 * for break-glass accounts, the LDAP path's own switch, the console flag that lifts it all, and the
 * sign-in overview saying which state it is in. The directory side against a real LDAP server is
 * in tests/integration/ldap/ldap-sign-in.test.ts.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { vi } from '@/tests/helpers/vi';
import { CookieJar, bootSaml, outcome, registerSamlCleanup } from '@/tests/helpers/saml-harness';
import {
  type SoftwareCredential,
  authenticationResponse,
  newCredential,
  registrationResponse,
} from '@/tests/helpers/webauthn';

vi.mock('next-intl/server', () => nextIntlServerMock());
registerSamlCleanup();

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Enforced-password-2026!';
const STAMPED = Symbol.for('cpm.peer-address-stamped');
const flags = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete flags[STAMPED];
});

async function setup() {
  const h = await bootSaml({ env: { AUTH_ALLOW_OAUTH_REGISTRATION: 'true' } });
  const users = await import('@/src/lib/models/user');
  const { hashPassword } = await import('@/src/lib/auth/password');
  const settings = await import('@/src/lib/settings');
  const make = async (email: string, username: string) => {
    const user = await users.createUser({
      email,
      provider: 'credentials',
      subject: email,
      passwordHash: await hashPassword(PASSWORD),
      username,
    });
    return user;
  };
  const alice = await make('alice@example.com', 'alice');
  const bob = await make('bob@example.com', 'bob');

  const password = (
    jar: CookieJar,
    path: '/sign-in/username' | '/sign-in/email' | '/sign-in/ldap',
    name: string,
  ) =>
    h.call(
      jar,
      'POST',
      path,
      path === '/sign-in/email'
        ? { email: name, password: PASSWORD }
        : { username: name, password: PASSWORD },
    );

  const registerPasskey = async (name: string) => {
    const jar = new CookieJar();
    expect((await password(jar, '/sign-in/username', name)).status).toBe(200);
    const options = await h.call(jar, 'GET', '/passkey/generate-register-options');
    const { challenge } = await options.json();
    const credential = newCredential();
    const verify = await h.call(jar, 'POST', '/passkey/verify-registration', {
      response: registrationResponse(credential, {
        challenge,
        origin: ORIGIN,
        rpId: 'localhost',
        userVerified: true,
      }),
      name: 'Laptop',
    });
    expect(verify.status).toBe(200);
    return { credential, jar };
  };

  const passkeySignIn = async (credential: SoftwareCredential) => {
    const jar = new CookieJar();
    const start = await h.call(jar, 'GET', '/passkey/generate-authenticate-options');
    const { challenge } = await start.json();
    const response = await h.call(jar, 'POST', '/passkey/verify-authentication', {
      response: authenticationResponse(credential, {
        challenge,
        origin: ORIGIN,
        rpId: 'localhost',
        userVerified: true,
        counter: Date.now() % 1_000_000,
      }),
    });
    return { jar, response };
  };

  const enforce = (patch: Record<string, unknown>) =>
    settings.saveSsoEnforcementSettings({ enforced: true, ...patch });

  return { h, settings, alice, bob, password, registerPasskey, passkeySignIn, enforce };
}

async function refusedForSso(response: Response) {
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body.code).toBe('SSO_REQUIRED');
}

describe('saving the policy', () => {
  it('refuses to enforce with no provider to send anyone to, or a break-glass account that is gone', async () => {
    const { h, settings, alice } = await setup();
    let code: string | null = null;
    try {
      await settings.saveSsoEnforcementSettings({
        enforced: true,
        breakGlassUserIds: [alice.id, 99_999],
      });
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe('breakGlassAccountUnknown');

    await h.samlModel.updateSamlProvider(h.provider.id, { enabled: false });
    code = null;
    try {
      await settings.saveSsoEnforcementSettings({ enforced: true });
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe('ssoEnforcementNeedsProvider');
    expect((await settings.getSsoEnforcementSettings()).enforced).toBe(false);
  });
});

describe('passwords while single sign-on is enforced', () => {
  it('refuses a username or email sign-in except for a break-glass account', async () => {
    const { password, enforce, bob } = await setup();
    await enforce({ breakGlassUserIds: [bob.id] });

    await refusedForSso(await password(new CookieJar(), '/sign-in/username', 'alice'));
    await refusedForSso(await password(new CookieJar(), '/sign-in/email', 'alice@example.com'));
    // An unknown name is refused the same way, before any password is checked.
    await refusedForSso(await password(new CookieJar(), '/sign-in/username', 'nobody'));

    const jar = new CookieJar();
    expect((await password(jar, '/sign-in/username', 'bob')).status).toBe(200);
    expect(jar.has('session_token')).toBe(true);
    expect((await password(new CookieJar(), '/sign-in/email', 'BOB@example.com')).status).toBe(200);
  });

  it('refuses registering a new local account', async () => {
    const { h, enforce } = await setup();
    await enforce({});
    const response = await h.call(new CookieJar(), 'POST', '/sign-up/email', {
      email: 'new@example.com',
      password: PASSWORD,
      name: 'New',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const users = await h.db
      .select()
      .from(h.schema.users)
      .where(eq(h.schema.users.email, 'new@example.com'));
    expect(users).toHaveLength(0);
  });

  it('still signs people in through the SAML provider', async () => {
    const { h, enforce } = await setup();
    await enforce({});
    const { response, jar } = await h.signIn();
    expect(outcome(response).error).toBeNull();
    expect(jar.has('session_token')).toBe(true);
  });
});

describe('passkeys while single sign-on is enforced', () => {
  it('refuses a passkey sign-in except for a break-glass account', async () => {
    const { registerPasskey, passkeySignIn, enforce, bob } = await setup();
    const alice = await registerPasskey('alice');
    const bobs = await registerPasskey('bob');
    await enforce({ breakGlassUserIds: [bob.id] });

    const refused = await passkeySignIn(alice.credential);
    await refusedForSso(refused.response);
    expect(refused.jar.has('session_token')).toBe(false);

    const allowed = await passkeySignIn(bobs.credential);
    expect(allowed.response.status).toBe(200);
    expect(allowed.jar.has('session_token')).toBe(true);
  });

  it('refuses adding a passkey to an account that is not break-glass', async () => {
    const { h, registerPasskey, enforce, bob } = await setup();
    const { jar } = await registerPasskey('alice');
    await enforce({ breakGlassUserIds: [bob.id] });
    await refusedForSso(await h.call(jar, 'GET', '/passkey/generate-register-options'));
  });
});

describe('the LDAP sign-in path while single sign-on is enforced', () => {
  it('is refused outright when LDAP is not allowed, break-glass names aside', async () => {
    const { password, enforce, bob } = await setup();
    await enforce({ allowLdap: false, breakGlassUserIds: [bob.id] });
    await refusedForSso(await password(new CookieJar(), '/sign-in/ldap', 'alice'));
    // Its local-account fallback is the break-glass account's way in, as /sign-in/username is.
    expect((await password(new CookieJar(), '/sign-in/ldap', 'bob')).status).toBe(200);
  });

  it('reaches the directory when LDAP is allowed, but not the local-account fallback', async () => {
    const { password, enforce, bob } = await setup();
    await enforce({ allowLdap: true, breakGlassUserIds: [bob.id] });
    // No directory here, so a name that reaches one gets the wrong-password answer.
    const alice = await password(new CookieJar(), '/sign-in/ldap', 'alice');
    expect(alice.status).toBe(401);
    expect((await alice.json()).code).toBe('INVALID_USERNAME_OR_PASSWORD');
    expect((await password(new CookieJar(), '/sign-in/ldap', 'bob')).status).toBe(200);
  });
});

describe('cpm-server --lift-sso-enforcement', () => {
  async function lift(
    purpose: 'lift-sso-enforcement' | 'lift-mfa-policy' = 'lift-sso-enforcement',
  ) {
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/src/app/api/internal/lift-sso-enforcement/route');
    const { config } = await import('@/src/lib/config');
    const { CONSOLE_SSO_SUBJECT, signConsoleCommand } = await import(
      '@/src/lib/users/console-command'
    );
    const { PEER_ADDRESS_HEADER } = await import('@/src/lib/http/peer-address');
    const timestamp = Date.now();
    return POST(
      new NextRequest('http://localhost/api/internal/lift-sso-enforcement', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PEER_ADDRESS_HEADER]: '127.0.0.1' },
        body: JSON.stringify({
          username: CONSOLE_SSO_SUBJECT,
          timestamp,
          signature: signConsoleCommand(
            config.sessionSecret,
            CONSOLE_SSO_SUBJECT,
            timestamp,
            purpose,
          ),
        }),
      }),
    );
  }

  it('turns enforcement off, so passwords work again, and audits it', async () => {
    const { settings, password, enforce } = await setup();
    await enforce({});
    flags[STAMPED] = true;

    expect((await lift('lift-mfa-policy')).status).toBe(404);
    expect((await settings.getSsoEnforcementSettings()).enforced).toBe(true);

    const response = await lift();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wasEnforced: true });
    expect((await settings.getSsoEnforcementSettings()).enforced).toBe(false);
    expect((await password(new CookieJar(), '/sign-in/username', 'alice')).status).toBe(200);

    // The preload mocks logAuditEvent for every file (tests/setup.bun.ts).
    const { logAuditEvent } = await import('@/src/lib/audit');
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sso_enforcement_lifted', userId: null }),
    );
  });

  it('answers nothing to a request that did not come from the console', async () => {
    const { settings, enforce } = await setup();
    await enforce({});
    delete flags[STAMPED];
    expect((await lift()).status).toBe(404);
    expect((await settings.getSsoEnforcementSettings()).enforced).toBe(true);
  });
});

describe('the sign-in overview', () => {
  it('reflects each state, and lists the SAML provider beside the OIDC ones', async () => {
    const { h, enforce, bob } = await setup();
    const { getSignInOverview } = await import('@/src/lib/users/sign-in-overview');

    let overview = await getSignInOverview();
    expect(overview.sso).toEqual({ enforced: false, allowLdap: true, breakGlass: [] });
    expect(overview.providers).toEqual([
      expect.objectContaining({ id: h.provider.id, protocol: 'saml', enabled: true }),
    ]);

    await enforce({ breakGlassUserIds: [bob.id], allowLdap: false });
    overview = await getSignInOverview();
    expect(overview.sso).toEqual({
      enforced: true,
      allowLdap: false,
      breakGlass: ['bob@example.com'],
    });

    await enforce({ allowLdap: true });
    expect((await getSignInOverview()).sso.allowLdap).toBe(true);
  });
});
