/**
 * `/sign-in/ldap` through Better Auth's real routes and a real database, against a real OpenLDAP:
 * provisioning, group roles, the transparent local-first fallback, the TOTP step, and the rules
 * that keep a directory entry from taking over a local account. Skips without Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadConfig } from '@/tests/helpers/config';
import { reloadDbModule } from '@/tests/helpers/fresh-db';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { vi } from '@/tests/helpers/vi';
import {
  LDAP_ADMIN_DN,
  LDAP_ADMIN_PASSWORD,
  LDAP_BASE_DN,
  LDAP_PASSWORDS,
  type TestLdapServer,
  startLdapServer,
} from '@/tests/helpers/ldap-server';

vi.mock('next-intl/server', () => nextIntlServerMock());

const ORIGIN = 'http://localhost:3000';
const LOCAL_PASSWORD = 'Local-password-2026!';

let server: TestLdapServer | null = null;
const cleanups: Array<() => void | Promise<void>> = [];
// Filled in beforeAll; the test tree allows `any`, as passkeys.test.ts does.
let env: any = null;

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

beforeAll(async () => {
  server = await startLdapServer();
  if (!server) {
    console.warn('[ldap-sign-in.test] Docker is not available; skipping');
    return;
  }
  cleanups.push(() => server?.stop());

  const database = await createTestDatabase();
  cleanups.push(() => database.drop());
  process.env.DATABASE_URL = database.url;
  delete process.env.CPM_EPHEMERAL_DB;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  process.env.AUTH_ALLOW_OAUTH_REGISTRATION = 'true';
  resetDbModuleState();

  await reloadConfig();
  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());

  const users = await import('@/src/lib/models/user');
  const directories = (await import(
    '@/src/lib/models/ldap-directories'
  )) as typeof import('@/src/lib/models/ldap-directories');
  const { hashPassword } = await import('@/src/lib/auth/password');
  const authServer = await import('@/src/lib/auth/server');
  const auth = await authServer.getAuth();

  const directory = await directories.createLdapDirectory({
    name: 'Example directory',
    url: server.ldapUrl,
    bindDn: LDAP_ADMIN_DN,
    bindPassword: LDAP_ADMIN_PASSWORD,
    config: { baseDn: LDAP_BASE_DN },
    roleMappingEnabled: true,
    adminGroup: 'Proxy Admins',
    defaultRole: 'viewer',
  });

  env = { db: dbModule.default, schema, users, directories, hashPassword, auth, directory };
}, 120_000);

afterAll(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  delete process.env.AUTH_ALLOW_OAUTH_REGISTRATION;
  resetDbModuleState();
});

const live = (name: string, run: () => Promise<void>) =>
  it(name, async () => {
    if (!server) return;
    await run();
  }, 30_000);

async function signIn(body: Record<string, unknown>) {
  const response: Response = await env.auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/ldap`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const json = await response.json().catch(() => null);
  const cookies = response.headers.getSetCookie().join('\n');
  return { status: response.status, json, cookies };
}

async function userByEmail(email: string) {
  const [row] = await env.db
    .select()
    .from(env.schema.users)
    .where(eq(env.schema.users.email, email));
  return row ?? null;
}

/** Tests run in a random order, so any that needs Alice's account makes sure it exists. */
async function ensureAlice() {
  const existing = await userByEmail('alice@example.org');
  if (existing) return existing;
  expect((await signIn({ username: 'alice', password: LDAP_PASSWORDS.alice })).status).toBe(200);
  return userByEmail('alice@example.org');
}

async function directoryAccounts(userId: number) {
  return env.db
    .select()
    .from(env.schema.accounts)
    .where(
      and(
        eq(env.schema.accounts.userId, userId),
        eq(env.schema.accounts.providerId, env.directory.id),
      ),
    );
}

describe('/sign-in/ldap', () => {
  live('creates the user on first sign-in, with the role its groups map to', async () => {
    const first = await signIn({ username: 'alice', password: LDAP_PASSWORDS.alice });
    expect(first.status).toBe(200);
    expect(first.cookies).toContain('session_token');

    const alice = await ensureAlice();
    expect(alice.role).toBe('admin');
    expect(alice.name).toBe('Alice Example');
    // No local password: the directory owns it.
    expect(alice.passwordHash).toBeNull();
    const [account] = await directoryAccounts(alice.id);
    expect(account.accountId).toMatch(/^[0-9a-f-]{36}$/);

    const again = await signIn({ username: 'alice', password: LDAP_PASSWORDS.alice });
    expect(again.status).toBe(200);
    expect(Number(again.json.user.id)).toBe(alice.id);
    expect(await directoryAccounts(alice.id)).toHaveLength(1);
  });

  live('gives an entry without mail a placeholder address and the default role', async () => {
    const response = await signIn({ username: 'bob', password: LDAP_PASSWORDS.bob });
    expect(response.status).toBe(200);
    const bob = await env.db
      .select()
      .from(env.schema.users)
      .where(eq(env.schema.users.id, Number(response.json.user.id)));
    expect(bob[0].email).toMatch(/^bob\.[0-9a-f]{8}@[0-9a-f-]{8}\.ldap\.invalid$/);
    expect(bob[0].role).toBe('viewer');
  });

  live('answers every refusal the same way', async () => {
    for (const body of [
      { username: 'alice', password: 'wrong' },
      { username: 'alice', password: '' },
      { username: 'nobody', password: 'whatever' },
      { username: 'twin', password: LDAP_PASSWORDS.twin },
      { username: '*', password: LDAP_PASSWORDS.alice },
      { username: 'alice', password: LDAP_PASSWORDS.alice, directoryId: 'no-such-directory' },
    ]) {
      const response = await signIn(body);
      expect(response.status).toBe(401);
      expect(response.json.code).toBe('INVALID_USERNAME_OR_PASSWORD');
      expect(response.cookies).not.toContain('session_token');
    }
  });

  live('tries a local account first, and falls through to the directory', async () => {
    const carol = await env.users.createUser({
      email: 'carol@localhost',
      provider: 'credentials',
      subject: 'carol@localhost',
      passwordHash: await env.hashPassword(LOCAL_PASSWORD),
    });
    await env.db
      .update(env.schema.users)
      .set({ username: 'carol' })
      .where(eq(env.schema.users.id, carol.id));

    const local = await signIn({ username: 'carol', password: LOCAL_PASSWORD });
    expect(local.status).toBe(200);
    expect(Number(local.json.user.id)).toBe(carol.id);

    // A named directory skips the local account.
    const named = await signIn({
      username: 'carol',
      password: LOCAL_PASSWORD,
      directoryId: env.directory.id,
    });
    expect(named.status).toBe(401);
  });

  live('never takes over a local account by email unless linking is on', async () => {
    // A directory entry whose mail is a local admin's address.
    const admin = await env.users.createUser({
      email: 'dave@example.org',
      provider: 'credentials',
      subject: 'dave@example.org',
      passwordHash: await env.hashPassword(LOCAL_PASSWORD),
      role: 'admin',
    });
    const { Client } = await import('ldapts');
    const client = new Client({ url: server?.ldapUrl ?? '' });
    await client.bind(LDAP_ADMIN_DN, LDAP_ADMIN_PASSWORD);
    await client.add(`uid=dave,ou=people,${LDAP_BASE_DN}`, {
      objectClass: ['inetOrgPerson'],
      uid: 'dave',
      cn: 'dave',
      sn: 'dave',
      mail: 'dave@example.org',
      userPassword: 'Dave-directory-2026!',
    });
    await client.unbind();

    const refused = await signIn({ username: 'dave', password: 'Dave-directory-2026!' });
    expect(refused.status).toBe(401);
    expect(await directoryAccounts(admin.id)).toHaveLength(0);

    await env.directories.updateLdapDirectory(env.directory.id, {
      name: env.directory.name,
      url: env.directory.url,
      config: {},
      autoLink: true,
    });
    try {
      const linked = await signIn({ username: 'dave', password: 'Dave-directory-2026!' });
      expect(linked.status).toBe(200);
      expect(Number(linked.json.user.id)).toBe(admin.id);
      expect(await directoryAccounts(admin.id)).toHaveLength(1);
    } finally {
      await env.directories.updateLdapDirectory(env.directory.id, {
        name: env.directory.name,
        url: env.directory.url,
        config: {},
        autoLink: false,
      });
    }
  });

  live('asks an account with 2FA for its code before any session', async () => {
    const alice = await ensureAlice();
    await env.db
      .update(env.schema.users)
      .set({ twoFactorEnabled: true })
      .where(eq(env.schema.users.id, alice.id));
    try {
      const response = await signIn({ username: 'alice', password: LDAP_PASSWORDS.alice });
      expect(response.status).toBe(200);
      expect(response.json.twoFactorRedirect).toBe(true);
      expect(response.cookies).toContain('two_factor');
      expect(response.cookies).not.toMatch(/session_token=[^;]+;/);
    } finally {
      await env.db
        .update(env.schema.users)
        .set({ twoFactorEnabled: false })
        .where(eq(env.schema.users.id, alice.id));
    }
  });

  live('refuses a disabled account with the same answer', async () => {
    const alice = await ensureAlice();
    await env.db
      .update(env.schema.users)
      .set({ status: 'disabled' })
      .where(eq(env.schema.users.id, alice.id));
    try {
      const response = await signIn({ username: 'alice', password: LDAP_PASSWORDS.alice });
      expect(response.status).toBe(401);
      expect(response.json.code).toBe('INVALID_USERNAME_OR_PASSWORD');
    } finally {
      await env.db
        .update(env.schema.users)
        .set({ status: 'active' })
        .where(eq(env.schema.users.id, alice.id));
    }
  });

  live('stays out of every OIDC reader', async () => {
    const oauth = await import('@/src/lib/models/oauth-providers');
    expect((await oauth.listOAuthProviders()).map((p: { id: string }) => p.id)).not.toContain(
      env.directory.id,
    );
    expect(await oauth.listEnabledOAuthProviders()).toHaveLength(0);
    expect(await oauth.getProviderDisplayList()).toHaveLength(0);
    expect(await oauth.getOAuthProvider(env.directory.id)).toBeNull();
    expect(await oauth.updateOAuthProvider(env.directory.id, { enabled: false })).toBeNull();
    await expect(oauth.deleteOAuthProvider(env.directory.id)).rejects.toThrow();
    // Nor can the OIDC paths (REST, GraphQL, Settings) make or convert one.
    await expect(
      oauth.createOAuthProvider({ name: 'Sneaky', type: 'ldap', clientId: 'x', clientSecret: 'y' }),
    ).rejects.toThrow();
    expect(await env.directories.getLdapDirectory(env.directory.id)).not.toBeNull();
  });
});

describe('/sign-in/ldap while single sign-on is enforced', () => {
  /** Written as stored: saving through Settings would want an SSO provider this file has none of. */
  async function withEnforcement(allowLdap: boolean, run: () => Promise<void>) {
    const { setSetting } = await import('@/src/lib/settings');
    await setSetting('sso_enforcement', { enforced: true, breakGlassUserIds: [], allowLdap });
    try {
      await run();
    } finally {
      await setSetting('sso_enforcement', {
        enforced: false,
        breakGlassUserIds: [],
        allowLdap: true,
      });
    }
  }

  live('signs a directory user in while "Allow LDAP" is on', async () => {
    await withEnforcement(true, async () => {
      const response = await signIn({ username: 'alice', password: LDAP_PASSWORDS.alice });
      expect(response.status).toBe(200);
      expect(response.cookies).toContain('session_token');
    });
  });

  live('refuses a directory user while "Allow LDAP" is off', async () => {
    await withEnforcement(false, async () => {
      const response = await signIn({ username: 'alice', password: LDAP_PASSWORDS.alice });
      expect(response.status).toBe(403);
      expect(response.json.code).toBe('SSO_REQUIRED');
      expect(response.cookies).not.toContain('session_token');
    });
  });
});
