/**
 * The pure parts of LDAP sign-in: escaping, settings validation, what reaches the browser, and the
 * wiring that puts a directory sign-in through the same 2FA, throttle and audit as a password one.
 */
import { describe, expect, it } from 'bun:test';
import { twoFactor } from 'better-auth/plugins';
import {
  buildGroupFilter,
  buildUserDn,
  buildUserFilter,
  escapeDnValue,
  escapeFilterValue,
  firstRdnValue,
  isValidFilterTemplate,
} from '@/src/lib/ldap/escape';
import {
  normalizeLdapConfig,
  parseLdapConfig,
  parseLdapUrl,
  validateLdapSettings,
} from '@/src/lib/ldap/config';
import {
  DEFAULT_LDAP_CONFIG,
  type LdapConfig,
  activeDirectoryBindTemplate,
} from '@/src/lib/ldap/defaults';
import {
  buildBindName,
  isAcceptableBindNameUsername,
  isBoundPrincipal,
  parseBindNameTemplate,
} from '@/src/lib/ldap/bind-name';
import {
  formatObjectGuid,
  isAcceptableLdapPassword,
  isAcceptableLdapUsername,
  stableAccountId,
} from '@/src/lib/ldap/client';
import { findTwoFactorAfterHook, ldapSignIn } from '@/src/lib/ldap/plugin';
import { CREDENTIAL_SIGN_IN_PATHS, isCredentialSignInPath } from '@/src/lib/auth/sign-in-paths';
import { DomainError } from '@/src/lib/errors/domain-error';
import { toLdapDirectoryView } from '@/src/lib/models/ldap-directories';

describe('filter escaping (RFC 4515)', () => {
  it('escapes every filter metacharacter and NUL', () => {
    expect(escapeFilterValue('*')).toBe('\\2a');
    expect(escapeFilterValue('(')).toBe('\\28');
    expect(escapeFilterValue(')')).toBe('\\29');
    expect(escapeFilterValue('\\')).toBe('\\5c');
    expect(escapeFilterValue('\u0000')).toBe('\\00');
    expect(escapeFilterValue('plain.name-1')).toBe('plain.name-1');
  });

  it('cannot close the filter or widen it', () => {
    const filter = buildUserFilter('(&(objectClass=person)(uid={username}))', 'x)(uid=*))(|(uid=*');
    expect(filter).toBe('(&(objectClass=person)(uid=x\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a))');
    expect(isValidFilterTemplate(filter.replace('x', '{username}'), '{username}')).toBe(true);
  });

  it('fills every placeholder', () => {
    expect(buildUserFilter('(|(uid={username})(mail={username}))', 'a*')).toBe(
      '(|(uid=a\\2a)(mail=a\\2a))',
    );
    expect(buildGroupFilter('(member={dn})', 'cn=a\\,b,dc=x')).toBe('(member=cn=a\\5c,b,dc=x)');
  });

  it('accepts only parseable templates that contain the placeholder', () => {
    expect(isValidFilterTemplate('(uid={username})', '{username}')).toBe(true);
    expect(isValidFilterTemplate('(uid=alice)', '{username}')).toBe(false);
    expect(isValidFilterTemplate('(uid={username}', '{username}')).toBe(false);
    expect(isValidFilterTemplate('(member:1.2.840.113556.1.4.1941:={dn})', '{dn}')).toBe(true);
  });
});

describe('DN escaping (RFC 4514)', () => {
  it('escapes the special characters, and spaces and # at the edges', () => {
    expect(escapeDnValue('a,b+c"d\\e<f>g;h=i')).toBe('a\\,b\\+c\\"d\\\\e\\<f\\>g\\;h\\=i');
    expect(escapeDnValue(' lead')).toBe('\\ lead');
    expect(escapeDnValue('trail ')).toBe('trail\\ ');
    expect(escapeDnValue('#hash')).toBe('\\#hash');
    expect(escapeDnValue('in#side mid')).toBe('in#side mid');
    expect(escapeDnValue('nul\u0000byte')).toBe('nul\\00byte');
  });

  it('cannot add an RDN to the template', () => {
    expect(buildUserDn('uid={username},ou=people,dc=example,dc=org', 'x,ou=admins')).toBe(
      'uid=x\\,ou\\=admins,ou=people,dc=example,dc=org',
    );
  });

  it('reads a group name back out of a DN', () => {
    expect(firstRdnValue('CN=Proxy Admins,OU=Groups,DC=example,DC=org')).toBe('Proxy Admins');
    expect(firstRdnValue('cn=Smith\\, John,ou=x')).toBe('Smith, John');
    expect(firstRdnValue('cn=Caf\\C3\\A9,ou=x')).toBe('Café');
    expect(firstRdnValue('no-equals-sign')).toBeNull();
  });
});

describe('input checks before any bind', () => {
  it('refuses an empty password, which is an unauthenticated bind', () => {
    expect(isAcceptableLdapPassword('')).toBe(false);
    expect(isAcceptableLdapPassword('x')).toBe(true);
    expect(isAcceptableLdapPassword('x'.repeat(2000))).toBe(false);
  });

  it('refuses control characters and overlong names', () => {
    expect(isAcceptableLdapUsername('alice')).toBe(true);
    expect(isAcceptableLdapUsername('DOMAIN\\alice')).toBe(true);
    expect(isAcceptableLdapUsername('')).toBe(false);
    expect(isAcceptableLdapUsername('al\u0000ice')).toBe(false);
    expect(isAcceptableLdapUsername('al\nice')).toBe(false);
    expect(isAcceptableLdapUsername('a'.repeat(257))).toBe(false);
  });
});

describe('stable account ids', () => {
  it("formats AD's objectGUID in its mixed byte order", () => {
    const bytes = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    expect(formatObjectGuid(bytes)).toBe('33221100-5544-7766-8899-aabbccddeeff');
    expect(formatObjectGuid(Buffer.alloc(3))).toBeNull();
  });

  it('prefers objectGUID, then entryUUID, then the DN', () => {
    const guid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    expect(stableAccountId({ dn: 'CN=A', objectGUID: guid, entryUUID: 'X' })).toBe(
      '33221100-5544-7766-8899-aabbccddeeff',
    );
    expect(stableAccountId({ dn: 'CN=A', entryUUID: 'ABC-DEF' })).toBe('abc-def');
    expect(stableAccountId({ dn: 'CN=A,DC=X' })).toBe('cn=a,dc=x');
  });
});

describe('directory settings', () => {
  const valid = (config: Partial<LdapConfig> = {}) => ({
    url: 'ldaps://ldap.example.org',
    config: { ...DEFAULT_LDAP_CONFIG, baseDn: 'dc=example,dc=org', ...config },
  });
  const codeOf = (run: () => void) => {
    try {
      run();
      return null;
    } catch (error) {
      return error instanceof DomainError ? error.code : String(error);
    }
  };

  it('takes only ldap:// and ldaps:// addresses, reduced to scheme, host and port', () => {
    expect(parseLdapUrl('ldaps://ldap.example.org')).toEqual({
      secure: true,
      host: 'ldap.example.org',
      port: 636,
      url: 'ldaps://ldap.example.org',
    });
    expect(parseLdapUrl('ldap://10.0.0.5:3389')?.port).toBe(3389);
    for (const bad of [
      'http://ldap.example.org',
      'ldap://',
      'ldap://user:pw@host',
      'ldap://host/dc=example',
      'ldap://host?x',
      'file:///etc/passwd',
      '',
    ]) {
      expect(parseLdapUrl(bad)).toBeNull();
    }
  });

  it('verifies TLS unless explicitly told not to', () => {
    expect(normalizeLdapConfig({}).tlsVerify).toBe(true);
    expect(normalizeLdapConfig({ tlsVerify: 'false' }).tlsVerify).toBe(true);
    expect(normalizeLdapConfig({ tlsVerify: false }).tlsVerify).toBe(false);
    expect(parseLdapConfig('not json').tlsVerify).toBe(true);
  });

  it('refuses each broken combination with its own code', () => {
    expect(codeOf(() => validateLdapSettings(valid()))).toBeNull();
    expect(codeOf(() => validateLdapSettings({ ...valid(), url: 'https://x' }))).toBe(
      'ldapUrlInvalid',
    );
    expect(codeOf(() => validateLdapSettings(valid({ startTls: true })))).toBe(
      'ldapStartTlsWithLdaps',
    );
    expect(codeOf(() => validateLdapSettings(valid({ baseDn: '' })))).toBe('ldapBaseDnRequired');
    expect(codeOf(() => validateLdapSettings(valid({ userFilter: '(uid=alice)' })))).toBe(
      'ldapUserFilterInvalid',
    );
    expect(codeOf(() => validateLdapSettings(valid({ userDnTemplate: 'uid=x' })))).toBe(
      'ldapDnTemplateInvalid',
    );
    expect(
      codeOf(() =>
        validateLdapSettings(valid({ groupSource: 'search', groupFilter: '(member=x)' })),
      ),
    ).toBe('ldapGroupFilterInvalid');
    expect(codeOf(() => validateLdapSettings(valid({ emailAttribute: 'mail)(x' })))).toBe(
      'ldapAttributeInvalid',
    );
    expect(codeOf(() => validateLdapSettings(valid({ caPem: 'not a certificate' })))).toBe(
      'ldapCaPemInvalid',
    );
  });
});

describe('binding as the user', () => {
  const upn = { kind: 'upn', realm: 'ad.example.org' } as const;
  const downLevel = { kind: 'down-level', domain: 'EXAMPLE' } as const;
  const valid = (url: string, config: Partial<LdapConfig>) => ({
    url,
    config: { ...DEFAULT_LDAP_CONFIG, baseDn: 'dc=ad,dc=example,dc=org', ...config },
  });
  const codeOf = (run: () => void) => {
    try {
      run();
      return null;
    } catch (error) {
      return error instanceof DomainError ? error.code : String(error);
    }
  };

  it('reads a template as a UPN, a down-level name or a DN', () => {
    expect(parseBindNameTemplate('{username}@ad.example.org')).toEqual(upn);
    expect(parseBindNameTemplate('EXAMPLE\\{username}')).toEqual(downLevel);
    expect(parseBindNameTemplate('uid={username},ou=people,dc=example,dc=org')).toEqual({
      kind: 'dn',
      template: 'uid={username},ou=people,dc=example,dc=org',
    });
    for (const bad of [
      '{username}',
      '{username}@',
      '{username}@-ad.example.org',
      '{username}@ad..example.org',
      '{username}@ad.example.org,x',
      '{username}@ad.example.org/x',
      'x{username}@ad.example.org',
      '{username}@{username}.org',
      'EXAMPLE\\{username}x',
      'EXAMPLE\\\\{username}',
      'A-NAME-FAR-TOO-LONG\\{username}',
      'EX AMPLE\\{username}',
      '\\{username}',
      'uid=x',
      'anything',
    ]) {
      expect(parseBindNameTemplate(bad)).toBeNull();
    }
  });

  it('fills a UPN or down-level name without escaping, so only a strict set is accepted', () => {
    expect(buildBindName(upn, 'alice')).toBe('alice@ad.example.org');
    expect(buildBindName(downLevel, 'alice')).toBe('EXAMPLE\\alice');
    for (const ok of ['alice', 'Alice.Smith', 'a', 'svc_cpm-2', 'x'.repeat(64)]) {
      expect(isAcceptableBindNameUsername(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'x'.repeat(65),
      'alice@evil.example',
      'alice@ad.example.org',
      'EVIL\\alice',
      'cn=admin,dc=example',
      'alice,ou=x',
      'alice+cn=x',
      'a"b',
      'a<b',
      'a>b',
      'a;b',
      'a=b',
      'alice smith',
      ' alice',
      'alice\u0000',
      'alice\n',
      '*',
      'al*',
      '*)(sAMAccountName=*',
      '.alice',
      'alice.',
      'élise',
      'a/b',
      'a:b',
      'a|b',
    ]) {
      expect(isAcceptableBindNameUsername(bad)).toBe(false);
    }
  });

  it('accepts the entry found only when it is the principal that bound', () => {
    const alice = {
      dn: 'CN=Alice,CN=Users,DC=ad,DC=example,DC=org',
      userPrincipalName: 'alice@ad.example.org',
      sAMAccountName: 'alice',
      authzId: 'u:EXAMPLE\\alice',
    };
    expect(isBoundPrincipal(upn, 'alice', alice)).toBe(true);
    expect(
      isBoundPrincipal(upn, 'ALICE', { ...alice, userPrincipalName: 'Alice@AD.example.org' }),
    ).toBe(true);
    expect(isBoundPrincipal(downLevel, 'alice', alice)).toBe(true);
    expect(isBoundPrincipal(downLevel, 'Alice', { ...alice, authzId: 'u:example\\ALICE' })).toBe(
      true,
    );
    // Without "Who am I?", the attribute alone decides.
    expect(isBoundPrincipal(upn, 'alice', { ...alice, authzId: null })).toBe(true);

    // Someone else's entry, as a filter matching too much would find.
    const bob = {
      dn: 'CN=Bob,CN=Users,DC=ad,DC=example,DC=org',
      userPrincipalName: 'bob@ad.example.org',
      sAMAccountName: 'bob',
      authzId: 'u:EXAMPLE\\alice',
    };
    expect(isBoundPrincipal(upn, 'alice', bob)).toBe(false);
    expect(isBoundPrincipal(downLevel, 'alice', bob)).toBe(false);
    // An implicit UPN is not enough: another entry could carry that UPN explicitly.
    expect(isBoundPrincipal(upn, 'alice', { ...alice, userPrincipalName: null })).toBe(false);
    expect(
      isBoundPrincipal(upn, 'alice', { ...alice, userPrincipalName: 'alice@other.example.org' }),
    ).toBe(false);
    // The same name in another domain.
    expect(isBoundPrincipal(downLevel, 'alice', { ...alice, authzId: 'u:OTHER\\alice' })).toBe(
      false,
    );
    expect(isBoundPrincipal(upn, 'alice', { ...alice, authzId: 'u:EXAMPLE\\bob' })).toBe(false);
    expect(isBoundPrincipal(upn, 'alice', { ...alice, authzId: `dn:${bob.dn}` })).toBe(false);
    expect(
      isBoundPrincipal(upn, 'alice', { ...alice, authzId: `dn:${alice.dn.toLowerCase()}` }),
    ).toBe(true);
    expect(isBoundPrincipal(upn, 'alice', { ...alice, authzId: 'something else' })).toBe(false);
  });

  it('offers the base DN domain as the Active Directory UPN suffix', () => {
    expect(activeDirectoryBindTemplate('DC=ad,DC=example,DC=org')).toBe(
      '{username}@ad.example.org',
    );
    expect(activeDirectoryBindTemplate('OU=Staff, dc=corp ,dc=local')).toBe(
      '{username}@corp.local',
    );
    expect(activeDirectoryBindTemplate('')).toBe('{username}@example.org');
    expect(parseBindNameTemplate(activeDirectoryBindTemplate('DC=ad,DC=example,DC=org'))).toEqual(
      upn,
    );
  });

  it('refuses a UPN or down-level bind without TLS, and leaves the DN form as it was', () => {
    for (const userDnTemplate of ['{username}@ad.example.org', 'EXAMPLE\\{username}']) {
      expect(codeOf(() => validateLdapSettings(valid('ldap://dc1', { userDnTemplate })))).toBe(
        'ldapUserBindNeedsTls',
      );
      expect(
        codeOf(() => validateLdapSettings(valid('ldap://dc1', { userDnTemplate, startTls: true }))),
      ).toBeNull();
      expect(
        codeOf(() => validateLdapSettings(valid('ldaps://dc1', { userDnTemplate }))),
      ).toBeNull();
    }
    expect(
      codeOf(() =>
        validateLdapSettings(
          valid('ldap://ldap', { userDnTemplate: 'uid={username},ou=people,dc=example,dc=org' }),
        ),
      ),
    ).toBeNull();
    // A service account is unchanged, TLS or not.
    expect(codeOf(() => validateLdapSettings(valid('ldap://ldap', {})))).toBeNull();
    expect(
      codeOf(() =>
        validateLdapSettings(valid('ldaps://dc1', { userDnTemplate: '{username}@bad..realm' })),
      ),
    ).toBe('ldapDnTemplateInvalid');
  });
});

describe('what reaches the browser', () => {
  it('never carries the bind password', () => {
    const view = toLdapDirectoryView({
      id: 'd',
      name: 'Dir',
      url: 'ldaps://x',
      bindDn: 'cn=svc',
      bindPassword: 'bind-password-sentinel',
      config: DEFAULT_LDAP_CONFIG,
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
    });
    expect(JSON.stringify(view)).not.toContain('bind-password-sentinel');
    expect(view.hasBindPassword).toBe(true);
  });
});

describe('sign-in wiring', () => {
  it("reuses the twoFactor plugin's credential after-hook for /sign-in/ldap", () => {
    const plugin = twoFactor({ issuer: 'Test' });
    const hook = findTwoFactorAfterHook(plugin);
    expect(hook).not.toBeNull();
    const after = (plugin as { hooks: { after: Array<{ handler: unknown }> } }).hooks.after;
    expect(after.map((h) => h.handler)).toContain(hook);

    const ldap = ldapSignIn({
      twoFactorAfterHook: hook,
      localUsersEnabled: true,
      allowRegistration: false,
    }) as unknown as {
      hooks: { after: Array<{ matcher: (c: { path: string }) => boolean; handler: unknown }> };
    };
    const [wired] = ldap.hooks.after;
    expect(wired.handler).toBe(hook);
    expect(wired.matcher({ path: '/sign-in/ldap' })).toBe(true);
    expect(wired.matcher({ path: '/sign-in/username' })).toBe(false);
  });

  it('counts a directory sign-in as a credential sign-in (throttle, CAPTCHA, deferred audit)', () => {
    expect(CREDENTIAL_SIGN_IN_PATHS).toContain('/sign-in/ldap');
    expect(isCredentialSignInPath('/sign-in/ldap')).toBe(true);
  });
});
