/**
 * Active Directory with no service account: CPM binds as the user by UPN or down-level name, then
 * finds and checks the user's own entry and nested groups with the user's own rights. Against a
 * real Samba 4 DC, through the client, `/sign-in/ldap`, the forward-auth portal and the Settings
 * test. Skips without Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { authenticateLdap, testLdapConnection } from '@/src/lib/ldap/client';
import {
  ACTIVE_DIRECTORY_PRESET,
  DEFAULT_LDAP_CONFIG,
  type LdapConfig,
  activeDirectoryBindTemplate,
} from '@/src/lib/ldap/defaults';
import { DomainError } from '@/src/lib/domain-error';
import type { LdapDirectory } from '@/src/lib/models/ldap-directories';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadConfig } from '@/tests/helpers/config';
import { reloadDbModule } from '@/tests/helpers/fresh-db';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import {
  AD_BASE_DN,
  AD_DOMAIN,
  AD_PASSWORDS,
  AD_REALM,
  type TestActiveDirectory,
  startActiveDirectory,
} from '@/tests/helpers/samba-ad';
import { vi } from '@/tests/helpers/vi';

vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ORIGIN = 'http://localhost:3000';
const ALICE_DN = `CN=Alice Example,CN=Users,${AD_BASE_DN}`;
const UPN_TEMPLATE = activeDirectoryBindTemplate(AD_BASE_DN);
const DOWN_LEVEL_TEMPLATE = `${AD_DOMAIN}\\{username}`;

let ad: TestActiveDirectory | null = null;
const cleanups: Array<() => void | Promise<void>> = [];
// Filled in beforeAll; the test tree allows `any`, as ldap-sign-in.test.ts does.
let env: any = null;

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

/** As an administrator would save it: the AD preset, binding as the user, over LDAPS. */
function directoryInput(url: string, config: Partial<LdapConfig> = {}) {
  return {
    name: 'Active Directory',
    url,
    bindDn: '',
    bindPassword: '',
    config: {
      ...ACTIVE_DIRECTORY_PRESET,
      baseDn: AD_BASE_DN,
      caPem: ad?.caPem ?? null,
      userDnTemplate: UPN_TEMPLATE,
      ...config,
    },
    roleMappingEnabled: true,
    adminGroup: 'Proxy Admins',
    defaultRole: 'viewer' as const,
  };
}

beforeAll(async () => {
  ad = await startActiveDirectory();
  if (!ad) {
    console.warn('[ldap-active-directory-user-bind.test] Docker is not available; skipping');
    return;
  }
  cleanups.push(() => ad?.stop());

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

  const actualAuth = await import('@/src/lib/auth');
  vi.mock('@/src/lib/auth', () => ({
    ...actualAuth,
    requireAdmin: async () => ({ user: { id: '1', role: 'admin' } }),
  }));

  const directories = (await import(
    '@/src/lib/models/ldap-directories'
  )) as typeof import('@/src/lib/models/ldap-directories');
  const authServer = await import('@/src/lib/auth-server');
  const auth = await authServer.getAuth();
  const forwardAuth = (await import(
    '@/src/lib/models/forward-auth'
  )) as typeof import('@/src/lib/models/forward-auth');
  const portal = await import('@/src/app/api/forward-auth/login/route');
  const actions = (await import(
    '@/src/app/(dashboard)/settings/ldap-actions'
  )) as typeof import('@/src/app/(dashboard)/settings/ldap-actions');

  const directory = await directories.createLdapDirectory(directoryInput(ad.ldapsUrl));
  env = {
    db: dbModule.default,
    schema,
    directories,
    directory,
    auth,
    forwardAuth,
    portal,
    actions,
  };
}, 240_000);

afterAll(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  process.env.CPM_EPHEMERAL_DB = TEST_ENV.CPM_EPHEMERAL_DB;
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  delete process.env.AUTH_ALLOW_OAUTH_REGISTRATION;
  resetDbModuleState();
});

// `it.skipIf` is decided at collection, before beforeAll starts the container.
const live = (name: string, run: () => Promise<void>) =>
  it(name, async () => {
    if (!ad) return;
    await run();
  }, 60_000);

/** Binding as the user by UPN over LDAPS, as a plain object for the client-level tests. */
function directory(
  overrides: Partial<Omit<LdapDirectory, 'config'>> & { config?: Partial<LdapConfig> } = {},
): LdapDirectory {
  const { config, ...rest } = overrides;
  return {
    id: 'test-ad-user-bind',
    name: 'Test AD',
    url: ad?.ldapsUrl ?? '',
    bindDn: '',
    bindPassword: '',
    autoLink: false,
    enabled: true,
    groupsClaim: 'memberOf',
    groupPrefix: null,
    roleMappingEnabled: false,
    adminGroup: null,
    operatorGroup: null,
    userGroup: null,
    viewerGroup: null,
    defaultRole: 'user',
    syncGroups: false,
    createdAt: '',
    updatedAt: '',
    ...rest,
    config: {
      ...DEFAULT_LDAP_CONFIG,
      ...ACTIVE_DIRECTORY_PRESET,
      baseDn: AD_BASE_DN,
      caPem: ad?.caPem ?? null,
      userDnTemplate: UPN_TEMPLATE,
      ...config,
    },
  };
}

const sorted = (list: string[]) => [...list].sort();
const NESTED = ['Engineering', 'Proxy Admins', 'Staff'];

describe('binding as the user against Active Directory', () => {
  live('signs in by UPN and reads nested groups with the user own rights', async () => {
    expect(UPN_TEMPLATE).toBe(`{username}@${AD_REALM}`);
    const result = await authenticateLdap(directory(), 'alice', AD_PASSWORDS.alice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.dn).toBe(ALICE_DN);
    expect(result.identity.email).toBe(`alice@${AD_REALM}`);
    expect(result.identity.accountId).toBe(await ad!.objectGuid('alice'));
    expect(sorted(result.identity.groups)).toEqual(NESTED);

    const memberOf = await authenticateLdap(
      directory({ config: { groupSource: 'memberOf' } }),
      'alice',
      AD_PASSWORDS.alice,
    );
    expect(memberOf.ok && sorted(memberOf.identity.groups)).toEqual(['Engineering', 'Staff']);
  });

  live('signs in by down-level name, and over StartTLS', async () => {
    const downLevel = await authenticateLdap(
      directory({ config: { userDnTemplate: DOWN_LEVEL_TEMPLATE } }),
      'alice',
      AD_PASSWORDS.alice,
    );
    expect(downLevel.ok).toBe(true);
    if (downLevel.ok) {
      expect(downLevel.identity.accountId).toBe(await ad!.objectGuid('alice'));
      expect(sorted(downLevel.identity.groups)).toEqual(NESTED);
    }
    // AD compares names without regard to case, and so does the principal check.
    expect(
      (
        await authenticateLdap(
          directory({ url: ad?.ldapUrl ?? '', config: { startTls: true } }),
          'ALICE',
          AD_PASSWORDS.alice,
        )
      ).ok,
    ).toBe(true);
  });

  live('refuses an entry that is not the account that bound', async () => {
    for (const userDnTemplate of [UPN_TEMPLATE, DOWN_LEVEL_TEMPLATE]) {
      // Matches everyone: more than one entry.
      expect(
        await authenticateLdap(
          directory({
            config: {
              userDnTemplate,
              userFilter: '(|(objectClass=user)(sAMAccountName={username}))',
            },
          }),
          'alice',
          AD_PASSWORDS.alice,
        ),
      ).toEqual({ ok: false, reason: 'ambiguous' });
      // Matches exactly one entry, and it is bob's: alice's password must not make her bob.
      expect(
        await authenticateLdap(
          directory({
            config: {
              userDnTemplate,
              userFilter: '(|(sAMAccountName=bob)(sAMAccountName={username}-nobody))',
            },
          }),
          'alice',
          AD_PASSWORDS.alice,
        ),
      ).toEqual({ ok: false, reason: 'other-entry' });
    }
    // A down-level name for another domain is refused by the DC itself.
    expect(
      await authenticateLdap(
        directory({ config: { userDnTemplate: 'OTHER\\{username}' } }),
        'alice',
        AD_PASSWORDS.alice,
      ),
    ).toEqual({ ok: false, reason: 'invalid-credentials' });
  });

  live('refuses a username a bind name cannot carry, before any bind', async () => {
    for (const name of [
      `alice@${AD_REALM}`,
      `${AD_DOMAIN}\\alice`,
      `svc-cpm@${AD_REALM}`,
      `${ALICE_DN}`,
      'alice,CN=Users',
      '*',
      'al*',
      '*)(sAMAccountName=*',
      'alice smith',
    ]) {
      for (const userDnTemplate of [UPN_TEMPLATE, DOWN_LEVEL_TEMPLATE]) {
        expect(
          await authenticateLdap(
            directory({ config: { userDnTemplate } }),
            name,
            AD_PASSWORDS.alice,
          ),
        ).toEqual({ ok: false, reason: 'refused-username' });
      }
    }
    expect(await authenticateLdap(directory(), 'alice', '')).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  live('refuses a wrong password, a disabled account and an unknown name at the bind', async () => {
    for (const userDnTemplate of [UPN_TEMPLATE, DOWN_LEVEL_TEMPLATE]) {
      const dir = directory({ config: { userDnTemplate } });
      for (const [name, password] of [
        ['alice', 'Not-her-password-1!'],
        ['carol', AD_PASSWORDS.carol],
        ['nobody', 'Whatever-2026!'],
      ]) {
        expect(await authenticateLdap(dir, name, password)).toEqual({
          ok: false,
          reason: 'invalid-credentials',
        });
      }
    }
  });

  live('tests the connection without an account, and signs in with a test user', async () => {
    expect(await testLdapConnection(directory())).toEqual({ ok: true, identity: null });
    expect(await testLdapConnection(directory({ config: { caPem: null } }))).toMatchObject({
      ok: false,
      stage: 'connect',
    });

    const reachable = await env.actions.testLdapDirectoryAction(
      directoryInput(ad!.ldapsUrl),
      null,
      null,
    );
    expect(reachable).toMatchObject({ ok: true, identity: null });
    expect(reachable.message).toMatch(/TLS is working/);

    const signedIn = await env.actions.testLdapDirectoryAction(directoryInput(ad!.ldapsUrl), null, {
      username: 'alice',
      password: AD_PASSWORDS.alice,
    });
    expect(signedIn.ok).toBe(true);
    expect(signedIn.identity).toMatchObject({ dn: ALICE_DN, role: 'admin' });

    const wrongEntry = await env.actions.testLdapDirectoryAction(
      directoryInput(ad!.ldapsUrl, {
        userFilter: '(|(sAMAccountName=bob)(sAMAccountName={username}-nobody))',
      }),
      null,
      { username: 'alice', password: AD_PASSWORDS.alice },
    );
    expect(wrongEntry.ok).toBe(false);
    expect(wrongEntry.message).toMatch(/different entry/);
  });

  live('will not save a UPN or down-level bind without TLS', async () => {
    for (const userDnTemplate of [UPN_TEMPLATE, DOWN_LEVEL_TEMPLATE]) {
      let code: string | null = null;
      try {
        await env.directories.createLdapDirectory({
          ...directoryInput(ad!.ldapUrl, { userDnTemplate }),
          name: `Plain ${userDnTemplate}`,
        });
      } catch (error) {
        code = error instanceof DomainError ? error.code : String(error);
      }
      expect(code).toBe('ldapUserBindNeedsTls');
    }
  });
});

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

async function userById(id: number) {
  const [row] = await env.db.select().from(env.schema.users).where(eq(env.schema.users.id, id));
  return row ?? null;
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

describe('/sign-in/ldap binding as the user', () => {
  live('keys the account on objectGUID and maps a nested group to the role', async () => {
    const first = await signIn({ username: 'alice', password: AD_PASSWORDS.alice });
    expect(first.status).toBe(200);
    expect(first.cookies).toContain('session_token');
    const alice = await userById(Number(first.json.user.id));
    expect(alice.email).toBe(`alice@${AD_REALM}`);
    // Only through Engineering, read with alice's own bind.
    expect(alice.role).toBe('admin');
    const [account] = await directoryAccounts(alice.id);
    expect(account.accountId).toBe(await ad!.objectGuid('alice'));

    // The down-level form finds the same entry, so the same account.
    await env.directories.updateLdapDirectory(
      env.directory.id,
      directoryInput(ad!.ldapsUrl, { userDnTemplate: DOWN_LEVEL_TEMPLATE }),
    );
    try {
      const again = await signIn({ username: 'alice', password: AD_PASSWORDS.alice });
      expect(again.status).toBe(200);
      expect(Number(again.json.user.id)).toBe(alice.id);
      expect(await directoryAccounts(alice.id)).toHaveLength(1);
    } finally {
      await env.directories.updateLdapDirectory(env.directory.id, directoryInput(ad!.ldapsUrl));
    }
  });

  live('answers every refusal the same way', async () => {
    for (const body of [
      { username: 'alice', password: 'Not-her-password-1!' },
      { username: 'carol', password: AD_PASSWORDS.carol },
      { username: 'nobody', password: 'Whatever-2026!' },
      { username: `alice@${AD_REALM}`, password: AD_PASSWORDS.alice },
      { username: `${AD_DOMAIN}\\alice`, password: AD_PASSWORDS.alice },
      { username: '*)(sAMAccountName=*', password: AD_PASSWORDS.alice },
      { username: 'alice', password: '' },
    ]) {
      const response = await signIn(body);
      expect(response.status).toBe(401);
      expect(response.json.code).toBe('INVALID_USERNAME_OR_PASSWORD');
      expect(response.cookies).not.toContain('session_token');
    }
  });
});

describe('the forward-auth portal binding as the user', () => {
  async function portalLogin(username: string, password: string, rid: string) {
    const response: Response = await env.portal.POST(
      new NextRequest(`${ORIGIN}/api/forward-auth/login`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, rid }),
      }),
    );
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  live('signs a directory user in through the shared path', async () => {
    const now = new Date().toISOString();
    const [host] = await env.db
      .insert(env.schema.proxyHosts)
      .values({
        name: 'App',
        domains: JSON.stringify(['app.example.com']),
        upstreams: JSON.stringify(['backend:8080']),
        sslForced: true,
        hstsEnabled: true,
        hstsSubdomains: false,
        allowWebsocket: true,
        preserveHostHeader: true,
        skipHttpsHostnameValidation: false,
        enabled: true,
        meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const target = 'https://app.example.com/dashboard';

    const refused = await portalLogin(
      'alice',
      'Not-her-password-1!',
      await env.forwardAuth.createRedirectIntent(target),
    );
    expect(refused.status).toBe(401);
    const refusedName = await portalLogin(
      `alice@${AD_REALM}`,
      AD_PASSWORDS.alice,
      await env.forwardAuth.createRedirectIntent(target),
    );
    expect(refusedName.status).toBe(401);

    const signIn = await signInOnce();
    await env.db.insert(env.schema.forwardAuthAccess).values({
      proxyHostId: host.id,
      userId: signIn,
      groupId: null,
      createdAt: now,
    });
    const accepted = await portalLogin(
      'alice',
      AD_PASSWORDS.alice,
      await env.forwardAuth.createRedirectIntent(target),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.json.redirectTo).toContain('/.cpm-auth/callback?code=');
  });
});

/** Alice's CPM user id, signing her in if no earlier test did. */
async function signInOnce(): Promise<number> {
  const response = await signIn({ username: 'alice', password: AD_PASSWORDS.alice });
  expect(response.status).toBe(200);
  return Number(response.json.user.id);
}
