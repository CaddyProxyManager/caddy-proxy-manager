/**
 * lib/ldap/client.ts against a real OpenLDAP: plain, StartTLS and LDAPS, with the certificate
 * verified. Skips when Docker is not available.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { authenticateLdap, testLdapConnection } from '@/src/lib/ldap/client';
import { DEFAULT_LDAP_CONFIG, type LdapConfig } from '@/src/lib/ldap/defaults';
import type { LdapDirectory } from '@/src/lib/models/ldap-directories';
import {
  LDAP_ADMIN_DN,
  LDAP_ADMIN_PASSWORD,
  LDAP_BASE_DN,
  LDAP_PASSWORDS,
  type TestLdapServer,
  startLdapServer,
} from '@/tests/helpers/ldap-server';

let server: TestLdapServer | null = null;

beforeAll(async () => {
  server = await startLdapServer();
  if (!server) console.warn('[ldap-client.test] Docker is not available; skipping');
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

function directory(
  overrides: Partial<Omit<LdapDirectory, 'config'>> & { config?: Partial<LdapConfig> } = {},
): LdapDirectory {
  const { config, ...rest } = overrides;
  return {
    id: 'test-directory',
    name: 'Test directory',
    url: server?.ldapUrl ?? '',
    bindDn: LDAP_ADMIN_DN,
    bindPassword: LDAP_ADMIN_PASSWORD,
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
    config: { ...DEFAULT_LDAP_CONFIG, baseDn: LDAP_BASE_DN, ...config },
  };
}

// `it.skipIf` is decided at collection, before beforeAll starts the container.
const live = (name: string, run: () => Promise<void>) =>
  it(name, async () => {
    if (!server) return;
    await run();
  }, 30_000);

describe('authenticateLdap', () => {
  live('signs in over plain LDAP and reads memberOf groups', async () => {
    const result = await authenticateLdap(directory(), 'alice', LDAP_PASSWORDS.alice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.dn).toBe(`uid=alice,ou=people,${LDAP_BASE_DN}`);
    expect(result.identity.email).toBe('alice@example.org');
    expect(result.identity.name).toBe('Alice Example');
    expect(result.identity.groups.sort()).toEqual(['Proxy Admins', 'Staff']);
    // OpenLDAP's entryUUID, not the DN.
    expect(result.identity.accountId).toMatch(/^[0-9a-f-]{36}$/);
  });

  live('signs in over StartTLS with the CA verified', async () => {
    const result = await authenticateLdap(
      directory({ config: { startTls: true, caPem: server?.caPem ?? null } }),
      'alice',
      LDAP_PASSWORDS.alice,
    );
    expect(result.ok).toBe(true);
  });

  live('signs in over LDAPS with the CA verified', async () => {
    const result = await authenticateLdap(
      directory({ url: server?.ldapsUrl ?? '', config: { caPem: server?.caPem ?? null } }),
      'alice',
      LDAP_PASSWORDS.alice,
    );
    expect(result.ok).toBe(true);
  });

  live('refuses an untrusted certificate unless verification is off', async () => {
    const strict = await authenticateLdap(
      directory({ url: server?.ldapsUrl ?? '' }),
      'alice',
      LDAP_PASSWORDS.alice,
    );
    expect(strict).toEqual({ ok: false, reason: 'unavailable' });

    const startTls = await authenticateLdap(
      directory({ config: { startTls: true } }),
      'alice',
      LDAP_PASSWORDS.alice,
    );
    // Fails closed: never a plain-text bind after a refused upgrade.
    expect(startTls).toEqual({ ok: false, reason: 'unavailable' });

    const lax = await authenticateLdap(
      directory({ url: server?.ldapsUrl ?? '', config: { tlsVerify: false } }),
      'alice',
      LDAP_PASSWORDS.alice,
    );
    expect(lax.ok).toBe(true);
  });

  live('tells a wrong password, an unknown name and an ambiguous one apart', async () => {
    expect(await authenticateLdap(directory(), 'alice', 'wrong')).toEqual({
      ok: false,
      reason: 'invalid-credentials',
    });
    expect(await authenticateLdap(directory(), 'nobody', 'whatever')).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await authenticateLdap(directory(), 'twin', LDAP_PASSWORDS.twin)).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  live('refuses an empty password before any bind', async () => {
    expect(await authenticateLdap(directory(), 'alice', '')).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  live('cannot be steered by filter syntax in the username', async () => {
    // Unescaped, `*` would match every uid and `)(` would close the filter early.
    for (const name of ['*', 'al*', 'alice)(uid=*', 'alice\\', 'ali\u0000ce']) {
      const result = await authenticateLdap(directory(), name, LDAP_PASSWORDS.alice);
      expect(result.ok).toBe(false);
    }
  });

  live('binds with a user-DN template and no service account', async () => {
    const result = await authenticateLdap(
      directory({
        bindDn: '',
        bindPassword: '',
        config: { userDnTemplate: `uid={username},ou=people,${LDAP_BASE_DN}` },
      }),
      'bob',
      LDAP_PASSWORDS.bob,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.email).toBeNull();
    expect(result.identity.groups).toEqual(['Staff']);
  });

  live('finds groups by search', async () => {
    const result = await authenticateLdap(
      directory({ config: { groupSource: 'search', groupFilter: '(uniqueMember={dn})' } }),
      'bob',
      LDAP_PASSWORDS.bob,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.groups).toEqual(['Staff']);
  });

  live('reports a refused service bind as unavailable, not as a wrong password', async () => {
    const result = await authenticateLdap(
      directory({ bindPassword: 'not-the-admin-password' }),
      'alice',
      LDAP_PASSWORDS.alice,
    );
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('testLdapConnection', () => {
  live('names the stage that failed', async () => {
    expect(await testLdapConnection(directory())).toEqual({ ok: true, identity: null });
    expect(
      await testLdapConnection(directory({ bindPassword: 'not-the-admin-password' })),
    ).toMatchObject({ ok: false, stage: 'bind' });
    expect(await testLdapConnection(directory({ url: server?.ldapsUrl ?? '' }))).toMatchObject({
      ok: false,
      stage: 'connect',
    });
    expect(await testLdapConnection(directory(), { username: 'alice', password: 'wrong' })).toEqual(
      { ok: false, stage: 'sign-in', reason: 'invalid-credentials' },
    );
  });
});
