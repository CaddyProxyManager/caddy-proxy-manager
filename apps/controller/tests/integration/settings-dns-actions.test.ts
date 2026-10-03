/**
 * Settings -> DNS providers: one form posts every provider edit (save, set default, remove) and
 * the challenge delegations, all into the `dns_provider` blob of the operator's change set.
 * Credentials are encrypted before they are staged, and a refused edit stages nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  session: null as null | { user: import('../helpers/settings-actions').SessionUser },
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

import messages from '../../messages/en.json';
import {
  checkDnsDelegationsAction,
  registerAcmeDnsAccountAction,
  updateDnsProviderSettingsAction,
} from '@/src/app/(dashboard)/settings/actions';
import { domainErrorMessage } from '@/src/lib/domain-error';
import { MAX_DNS_DELEGATIONS } from '@/src/lib/dns-challenge-delegation';
import { decryptSecret, isEncryptedSecret } from '@/src/lib/secret';
import { setSetting } from '@/src/lib/settings';
import { testTranslator } from '../helpers/next-intl';
import {
  type SessionUser,
  form,
  seedUser,
  stagedKeys,
  stagedSetting,
} from '../helpers/settings-actions';

const t = testTranslator('settings.results');
const STAGED = { success: true, staged: true, message: messages.settings.stagedSaved };

let admin: SessionUser;

const dnsProvider = () => stagedSetting(ctx.db, admin.id, 'dns_provider');
const save = (fields: Record<string, string>) =>
  updateDnsProviderSettingsAction(null, form(fields));
const refused = (message: string) => ({ success: false, message });

beforeEach(async () => {
  ctx.db = await createTestDb();
  admin = await seedUser(ctx.db, 'admin@example.com', 'admin');
  ctx.session = { user: admin };
});

describe('saving a provider', () => {
  it('encrypts its secret and makes the first one the default', async () => {
    expect(await save({ provider: 'cloudflare', credential_api_token: ' cf-token ' })).toEqual(
      STAGED,
    );

    const settings = await dnsProvider();
    expect(settings.default).toBe('cloudflare');
    expect(isEncryptedSecret(settings.providers.cloudflare.api_token)).toBe(true);
    expect(decryptSecret(settings.providers.cloudflare.api_token)).toBe('cf-token');
  });

  it('leaves the default alone for a second provider, and keeps a blank field stored', async () => {
    await save({ provider: 'cloudflare', credential_api_token: 'cf-token' });
    await save({ provider: 'duckdns', credential_api_token: 'duck' });
    await save({
      provider: 'cloudflare',
      credential_api_token: '',
      credential_propagation_timeout: '2m',
    });

    const settings = await dnsProvider();
    expect(settings.default).toBe('cloudflare');
    expect(Object.keys(settings.providers).sort()).toEqual(['cloudflare', 'duckdns']);
    expect(decryptSecret(settings.providers.cloudflare.api_token)).toBe('cf-token');
    expect(settings.providers.cloudflare.propagation_timeout).toBe('2m');
  });

  const REFUSALS: Array<[string, Record<string, string>, string]> = [
    ['no provider', { provider: '' }, t('dnsProviderSelect')],
    ['"none"', { provider: 'none' }, t('dnsProviderSelect')],
    ['an unknown provider', { provider: 'bogus' }, t('dnsProviderUnknown', { name: 'bogus' })],
    [
      'a missing required field',
      { provider: 'cloudflare' },
      t('dnsProviderFieldRequired', { field: 'API Token', provider: 'Cloudflare' }),
    ],
    [
      'a malformed duration',
      { provider: 'cloudflare', credential_api_token: 'x', credential_propagation_delay: 'soon' },
      t('dnsProviderFieldDuration', { field: 'Propagation Delay' }),
    ],
  ];
  for (const [name, fields, message] of REFUSALS) {
    it(`refuses ${name} and stages nothing`, async () => {
      expect(await save(fields)).toEqual(refused(message));
      expect(await stagedKeys(ctx.db)).toEqual([]);
    });
  }
});

describe('the default provider', () => {
  beforeEach(async () => {
    await save({ provider: 'cloudflare', credential_api_token: 'cf' });
    await save({ provider: 'duckdns', credential_api_token: 'duck' });
  });

  it('can be switched to another configured provider, or to none', async () => {
    expect(await save({ action: 'set-default', provider: 'duckdns' })).toEqual(STAGED);
    expect((await dnsProvider()).default).toBe('duckdns');

    expect(await save({ action: 'set-default', provider: 'none' })).toEqual(STAGED);
    expect((await dnsProvider()).default).toBeNull();
  });

  it('cannot be a provider that is not configured', async () => {
    expect(await save({ action: 'set-default', provider: 'hetzner' })).toEqual(
      refused(t('dnsProviderNotConfigured', { name: 'hetzner' })),
    );
    expect((await dnsProvider()).default).toBe('cloudflare');
  });

  it('passes to a remaining provider when it is removed', async () => {
    expect(await save({ action: 'remove', provider: 'cloudflare' })).toEqual(STAGED);

    const settings = await dnsProvider();
    expect(Object.keys(settings.providers)).toEqual(['duckdns']);
    expect(settings.default).toBe('duckdns');
  });

  it('is cleared when the last provider goes', async () => {
    await save({ action: 'remove', provider: 'cloudflare' });
    await save({ action: 'remove', provider: 'duckdns' });

    expect(await dnsProvider()).toMatchObject({ providers: {}, default: null });
  });

  it('refuses to remove a provider that is not there', async () => {
    expect(await save({ action: 'remove', provider: 'hetzner' })).toEqual(
      refused(t('dnsProviderNothingToRemove')),
    );
  });

  it('refuses to remove a provider a delegation still uses', async () => {
    await save({ action: 'delegation-save', domain: 'example.com', delegationProvider: 'duckdns' });

    expect(await save({ action: 'remove', provider: 'duckdns' })).toEqual(
      refused(t('dnsProviderUsedByDelegations', { domains: 'example.com' })),
    );
    expect((await dnsProvider()).providers.duckdns).toBeDefined();
  });
});

describe('challenge delegations', () => {
  beforeEach(async () => {
    await save({ provider: 'cloudflare', credential_api_token: 'cf' });
  });

  it('keys a delegation by its base name and replaces it on a second save', async () => {
    expect(
      await save({
        action: 'delegation-save',
        domain: '*.Example.com.',
        target: 'Example.acme.test.',
      }),
    ).toEqual(STAGED);
    await save({
      action: 'delegation-save',
      domain: 'example.com',
      delegationProvider: 'cloudflare',
    });

    expect((await dnsProvider()).delegations).toEqual([
      { domain: 'example.com', target: null, provider: 'cloudflare' },
    ]);
  });

  it('treats "default" as no provider', async () => {
    await save({
      action: 'delegation-save',
      domain: 'a.example.com',
      target: 'a.acme.test',
      delegationProvider: 'default',
    });

    expect((await dnsProvider()).delegations).toEqual([
      { domain: 'a.example.com', target: 'a.acme.test', provider: null },
    ]);
  });

  const REFUSALS: Array<[string, Record<string, string>, string]> = [
    ['a domain that is no DNS name', { domain: 'not a domain' }, t('dnsDelegationDomainInvalid')],
    [
      'a target that is no DNS name',
      { domain: 'example.com', target: 'http://x' },
      t('dnsDelegationTargetInvalid'),
    ],
    [
      'a provider that is not configured',
      { domain: 'example.com', delegationProvider: 'duckdns' },
      t('dnsProviderNotConfigured', { name: 'duckdns' }),
    ],
    ['neither a target nor a provider', { domain: 'example.com' }, t('dnsDelegationNeedsTarget')],
  ];
  for (const [name, fields, message] of REFUSALS) {
    it(`refuses ${name}`, async () => {
      expect(await save({ action: 'delegation-save', ...fields })).toEqual(refused(message));
      expect((await dnsProvider()).delegations).toBeUndefined();
    });
  }
});

// Stored rather than staged: a staged blob would shadow them.
describe('delegations already applied', () => {
  it('refuses one more than the limit, but still replaces an existing one', async () => {
    const delegations = Array.from({ length: MAX_DNS_DELEGATIONS }, (_, i) => ({
      domain: `d${i}.example.com`,
      target: `d${i}.acme.test`,
      provider: null,
    }));
    await setSetting('dns_provider', { providers: {}, default: null, delegations });

    expect(
      await save({ action: 'delegation-save', domain: 'new.example.com', target: 'x.test' }),
    ).toEqual(refused(t('dnsDelegationTooMany', { max: MAX_DNS_DELEGATIONS })));
    expect(
      await save({ action: 'delegation-save', domain: 'd0.example.com', target: 'y.test' }),
    ).toEqual(STAGED);
  });

  it('removes a delegation together with its acme-dns account', async () => {
    await setSetting('dns_provider', {
      providers: { acmedns: {} },
      default: null,
      delegations: [
        { domain: 'example.com', target: null, provider: 'acmedns' },
        { domain: 'other.com', target: 'o.acme.test', provider: null },
      ],
      acmeDnsAccounts: {
        'example.com': {
          username: 'u',
          password: 'p',
          subdomain: 's',
          fulldomain: 'f.test',
          server_url: 'https://acme.test',
        },
      },
    });

    expect(await save({ action: 'delegation-remove', domain: '*.example.com' })).toEqual(STAGED);

    const settings = await dnsProvider();
    expect(settings.delegations).toEqual([
      { domain: 'other.com', target: 'o.acme.test', provider: null },
    ]);
    expect(settings.acmeDnsAccounts).toEqual({});
  });
});

describe('registering with acme-dns', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('stages the account and its delegation, and returns the CNAME to create', async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { username: 'u', password: 'p', subdomain: 's', fulldomain: 's.auth.example.net' },
        { status: 201 },
      )) as unknown as typeof fetch;

    const result = await registerAcmeDnsAccountAction(
      null,
      form({ domain: 'example.com', serverUrl: 'https://auth.example.net' }),
    );

    expect(result).toMatchObject({ success: true, staged: true });
    expect(result.cname).toEqual({
      name: '_acme-challenge.example.com',
      target: 's.auth.example.net',
    });
    const settings = await dnsProvider();
    expect(settings.delegations).toEqual([
      { domain: 'example.com', target: null, provider: 'acmedns' },
    ]);
    expect(decryptSecret(settings.acmeDnsAccounts['example.com'].password)).toBe('p');
  });

  it('refuses a bad domain or a missing server before calling anything', async () => {
    const calls = vi.fn();
    globalThis.fetch = calls as unknown as typeof fetch;

    expect(
      await registerAcmeDnsAccountAction(null, form({ domain: '', serverUrl: 'https://a.test' })),
    ).toEqual(refused(t('dnsDelegationDomainInvalid')));
    expect(await registerAcmeDnsAccountAction(null, form({ domain: 'example.com' }))).toEqual(
      refused(t('acmeDnsServerUrlRequired')),
    );
    expect(calls).not.toHaveBeenCalled();
    expect(await stagedKeys(ctx.db)).toEqual([]);
  });
});

describe('checking delegations', () => {
  it('has nothing to look up before any delegation exists', async () => {
    expect(await checkDnsDelegationsAction()).toEqual([]);
  });

  it('is for administrators only', async () => {
    ctx.session = { user: await seedUser(ctx.db, 'op@example.com', 'operator') };

    await expect(checkDnsDelegationsAction()).rejects.toThrow(domainErrorMessage('adminRequired'));
    await expect(save({ provider: 'cloudflare', credential_api_token: 'x' })).rejects.toThrow(
      domainErrorMessage('adminRequired'),
    );
  });
});
