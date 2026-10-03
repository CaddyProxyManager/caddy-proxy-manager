/**
 * LDAP sign-in against a real Active Directory (Samba 4): the AD preset's sAMAccountName filter,
 * nested groups through LDAP_MATCHING_RULE_IN_CHAIN, objectGUID as the account id across a rename,
 * a bind by UPN, disabled accounts, and AD's refusal of simple binds in the clear. Skips without
 * Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { authenticateLdap, testLdapConnection } from '@/src/lib/ldap/client';
import {
  ACTIVE_DIRECTORY_PRESET,
  DEFAULT_LDAP_CONFIG,
  type LdapConfig,
} from '@/src/lib/ldap/defaults';
import type { LdapDirectory } from '@/src/lib/models/ldap-directories';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { fresh } from '@/tests/helpers/fresh';
import { reloadDbModule } from '@/tests/helpers/fresh-db';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import {
  AD_BASE_DN,
  AD_PASSWORDS,
  AD_REALM,
  AD_SERVICE_UPN,
  type TestActiveDirectory,
  startActiveDirectory,
} from '@/tests/helpers/samba-ad';
import { vi } from '@/tests/helpers/vi';

vi.mock('next-intl/server', () => nextIntlServerMock());

const ORIGIN = 'http://localhost:3000';
const ALICE_DN = `CN=Alice Example,CN=Users,${AD_BASE_DN}`;

let ad: TestActiveDirectory | null = null;
const cleanups: Array<() => void | Promise<void>> = [];
// Filled in beforeAll; the test tree allows `any`, as ldap-sign-in.test.ts does.
let env: any = null;

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

beforeAll(async () => {
  ad = await startActiveDirectory();
  if (!ad) {
    console.warn('[ldap-active-directory.test] Docker is not available; skipping');
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

  const config = await import(`@/src/lib/config${fresh()}`);
  vi.mock('@/src/lib/config', () => ({ ...config }));
  const { dbModule, schema } = await reloadDbModule();
  cleanups.push(() => (dbModule.client as { close?: () => Promise<void> })?.close?.());

  const directories = (await import(
    `@/src/lib/models/ldap-directories${fresh()}`
  )) as typeof import('@/src/lib/models/ldap-directories');
  const authServer = await import(`@/src/lib/auth-server${fresh()}`);
  const auth = await authServer.getAuth();

  // As an administrator would set it up: the AD preset over LDAPS, with the DC's CA.
  const directory = await directories.createLdapDirectory({
    name: 'Active Directory',
    url: ad.ldapsUrl,
    bindDn: AD_SERVICE_UPN,
    bindPassword: AD_PASSWORDS.service,
    config: { ...ACTIVE_DIRECTORY_PRESET, baseDn: AD_BASE_DN, caPem: ad.caPem },
    roleMappingEnabled: true,
    adminGroup: 'Proxy Admins',
    defaultRole: 'viewer',
  });

  env = { db: dbModule.default, schema, directory, auth };
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

/** The AD preset over LDAPS, as a plain object for the client-level tests. */
function directory(
  overrides: Partial<Omit<LdapDirectory, 'config'>> & { config?: Partial<LdapConfig> } = {},
): LdapDirectory {
  const { config, ...rest } = overrides;
  return {
    id: 'test-ad',
    name: 'Test AD',
    url: ad?.ldapsUrl ?? '',
    bindDn: AD_SERVICE_UPN,
    bindPassword: AD_PASSWORDS.service,
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
      ...config,
    },
  };
}

const sorted = (list: string[]) => [...list].sort();

describe('authenticateLdap against Active Directory', () => {
  live('binds as a service account by UPN and finds the user by sAMAccountName', async () => {
    const result = await authenticateLdap(directory(), 'alice', AD_PASSWORDS.alice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.dn).toBe(ALICE_DN);
    expect(result.identity.email).toBe(`alice@${AD_REALM}`);
    expect(result.identity.name).toBe('Alice Example');
    // Byte order included: the string Samba prints is the one AD tools show.
    expect(result.identity.accountId).toBe(await ad!.objectGuid('alice'));
  });

  live('follows nested groups with the in-chain matching rule', async () => {
    const result = await authenticateLdap(directory(), 'alice', AD_PASSWORDS.alice);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(sorted(result.identity.groups)).toEqual(['Engineering', 'Proxy Admins', 'Staff']);
    }

    const scoped = await authenticateLdap(
      directory({ config: { groupBaseDn: `CN=Users,${AD_BASE_DN}` } }),
      'alice',
      AD_PASSWORDS.alice,
    );
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      expect(sorted(scoped.identity.groups)).toEqual(['Engineering', 'Proxy Admins', 'Staff']);
    }
  });

  live('reads only direct groups from memberOf', async () => {
    const result = await authenticateLdap(
      directory({ config: { groupSource: 'memberOf' } }),
      'alice',
      AD_PASSWORDS.alice,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(sorted(result.identity.groups)).toEqual(['Engineering', 'Staff']);
  });

  live('signs in by userPrincipalName with a UPN filter', async () => {
    const result = await authenticateLdap(
      directory({
        config: { userFilter: '(&(objectCategory=person)(userPrincipalName={username}))' },
      }),
      `alice@${AD_REALM}`,
      AD_PASSWORDS.alice,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.accountId).toBe(await ad!.objectGuid('alice'));
  });

  live('signs in over StartTLS on 389 with the certificate verified', async () => {
    const result = await authenticateLdap(
      directory({ url: ad?.ldapUrl ?? '', config: { startTls: true } }),
      'alice',
      AD_PASSWORDS.alice,
    );
    expect(result.ok).toBe(true);
  });

  live('is refused a simple bind in the clear, as AD refuses it', async () => {
    expect(
      await authenticateLdap(directory({ url: ad?.ldapUrl ?? '' }), 'alice', AD_PASSWORDS.alice),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(await testLdapConnection(directory({ url: ad?.ldapUrl ?? '' }))).toMatchObject({
      ok: false,
      stage: 'bind',
    });
  });

  live('refuses the DC certificate without its CA', async () => {
    const untrusted = directory({ config: { caPem: null } });
    expect(await authenticateLdap(untrusted, 'alice', AD_PASSWORDS.alice)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await testLdapConnection(untrusted)).toMatchObject({ ok: false, stage: 'connect' });
    expect(
      await authenticateLdap(
        directory({ url: ad?.ldapUrl ?? '', config: { startTls: true, caPem: null } }),
        'alice',
        AD_PASSWORDS.alice,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(await testLdapConnection(directory())).toEqual({ ok: true, identity: null });
  });

  live('refuses a wrong password and a disabled account at the bind', async () => {
    expect(await authenticateLdap(directory(), 'alice', 'Not-her-password-1!')).toEqual({
      ok: false,
      reason: 'invalid-credentials',
    });
    // AD answers a disabled account's correct password with invalidCredentials (data 533).
    expect(await authenticateLdap(directory(), 'carol', AD_PASSWORDS.carol)).toEqual({
      ok: false,
      reason: 'invalid-credentials',
    });
  });

  live('cannot be steered by filter syntax in the username', async () => {
    for (const name of ['*', 'al*', '*)(sAMAccountName=*', 'alice)(|(sAMAccountName=*']) {
      expect(await authenticateLdap(directory(), name, AD_PASSWORDS.alice)).toEqual({
        ok: false,
        reason: 'not-found',
      });
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

describe('/sign-in/ldap against Active Directory', () => {
  live('keys the account on objectGUID and maps a nested group to the role', async () => {
    const first = await signIn({ username: 'alice', password: AD_PASSWORDS.alice });
    expect(first.status).toBe(200);
    expect(first.cookies).toContain('session_token');
    const alice = await userById(Number(first.json.user.id));
    expect(alice.email).toBe(`alice@${AD_REALM}`);
    // Only through Engineering: a memberOf reading would leave her a viewer.
    expect(alice.role).toBe('admin');
    const [account] = await directoryAccounts(alice.id);
    expect(account.accountId).toBe(await ad!.objectGuid('alice'));

    // sAMAccountName matches without regard to case; the GUID keeps it one account.
    const again = await signIn({ username: 'ALICE', password: AD_PASSWORDS.alice });
    expect(again.status).toBe(200);
    expect(Number(again.json.user.id)).toBe(alice.id);
    expect(await directoryAccounts(alice.id)).toHaveLength(1);
  });

  live('keeps the same user when the entry is renamed', async () => {
    const before = await signIn({ username: 'bob', password: AD_PASSWORDS.bob });
    expect(before.status).toBe(200);
    const userId = Number(before.json.user.id);
    // A new CN is a new DN; objectGUID does not move.
    await ad!.sambaTool('user', 'rename', 'bob', '--force-new-cn=Robert Renamed');
    try {
      const after = await signIn({ username: 'bob', password: AD_PASSWORDS.bob });
      expect(after.status).toBe(200);
      expect(Number(after.json.user.id)).toBe(userId);
      expect(await directoryAccounts(userId)).toHaveLength(1);
    } finally {
      await ad!.sambaTool('user', 'rename', 'bob', '--force-new-cn=Bob Example');
    }
  });

  live('gives an entry without mail a placeholder address and the default role', async () => {
    const response = await signIn({ username: 'bob', password: AD_PASSWORDS.bob });
    expect(response.status).toBe(200);
    const bob = await userById(Number(response.json.user.id));
    expect(bob.email).toMatch(/^bob\.[0-9a-f]{8}@[0-9a-f-]{8}\.ldap\.invalid$/);
    expect(bob.role).toBe('viewer');
  });

  live('answers every refusal the same way', async () => {
    for (const body of [
      { username: 'alice', password: 'Not-her-password-1!' },
      { username: 'carol', password: AD_PASSWORDS.carol },
      { username: 'nobody', password: 'Whatever-2026!' },
      { username: '*)(sAMAccountName=*', password: AD_PASSWORDS.alice },
      { username: '*', password: AD_PASSWORDS.alice },
    ]) {
      const response = await signIn(body);
      expect(response.status).toBe(401);
      expect(response.json.code).toBe('INVALID_USERNAME_OR_PASSWORD');
      expect(response.cookies).not.toContain('session_token');
    }
    // The disabled account never got a CPM user either.
    const [carol] = await env.db
      .select()
      .from(env.schema.users)
      .where(eq(env.schema.users.email, `carol@${AD_REALM}`));
    expect(carol).toBeUndefined();
  });
});
