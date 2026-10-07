/**
 * The Settings actions that apply at once rather than stage: the registry blocks, CAPTCHA,
 * update checks, analytics and GeoIP (which start or stop containers through the agent),
 * and the WAF rule shortcuts. Each writes `settings` directly and leaves the change set empty; for
 * a non-administrator each answers with a refusal rather than a thrown error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  session: null as null | { user: import('../../helpers/settings-actions').SessionUser },
}));

const schemaModule = await import('@/src/lib/db/schema');
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  auth: vi.fn(async () => ctx.session),
}));

import * as actions from '@/src/app/(dashboard)/settings/actions';
import { domainErrorMessage } from '@/src/lib/errors/domain-error';
import { decryptSecret, isEncryptedSecret } from '@/src/lib/secrets';
import * as registry from '@/src/lib/settings/registry';
import { invalidateSettingsCache } from '@/src/lib/settings/resolve';
import { invalidateClickHouseConfig } from '@/src/lib/clickhouse/client';
import { installFakeCaddy } from '../../helpers/caddy-admin';
import { type FakeAgent, startFakeAgent } from '../../helpers/fake-agent';
import { testTranslator } from '../../helpers/next-intl';
import {
  type SessionUser,
  form,
  seedUser,
  stagedKeys,
  storedSetting,
} from '../../helpers/settings-actions';

const t = testTranslator('settings.results');
const tSettings = testTranslator('settings');
const REFUSED = { success: false, message: domainErrorMessage('accessDenied') };

let admin: SessionUser;
const realFetch = globalThis.fetch;
/** Anything reaching the network here is a bug in the test. */
const offline = vi.fn(async () => {
  throw new Error('offline');
});

const stored = (key: string) => storedSetting(ctx.db, key);

beforeEach(async () => {
  ctx.db = await createTestDb();
  invalidateSettingsCache();
  await invalidateClickHouseConfig();
  admin = await seedUser(ctx.db, 'admin@example.com', 'admin');
  ctx.session = { user: admin };
  installFakeCaddy();
  offline.mockClear();
  globalThis.fetch = offline as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  // Nothing may be staged by an action that applies at once.
  expect(await stagedKeys(ctx.db)).toEqual([]);
});

describe('a registry block', () => {
  it('saves the fields it owns, and a clear checkbox as false', async () => {
    const result = await actions.updateRegistrySettingsAction(
      null,
      form({
        registryBlock: 'sign-in',
        [registry.loginMaxAttempts.key]: '7',
        [registry.appName.key]: 'Not in this block',
        $ACTION_ID_abc: 'react bookkeeping',
      }),
    );

    expect(result).toEqual({ success: true, message: t('registrySaved') });
    expect(await stored(registry.loginMaxAttempts.key)).toBe(7);
    expect(await stored(registry.allowSelfRegistration.key)).toBe(false);
    expect(await stored(registry.appName.key)).toBeUndefined();
  });

  it('writes nothing when one field is out of range', async () => {
    const result = await actions.updateRegistrySettingsAction(
      null,
      form({
        registryBlock: 'sign-in',
        [registry.loginMaxAttempts.key]: '0',
        [registry.allowSelfRegistration.key]: 'on',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed logins before lockout');
    expect(await stored(registry.allowSelfRegistration.key)).toBeUndefined();
  });

  it('refuses a block that does not exist', async () => {
    expect(
      await actions.updateRegistrySettingsAction(null, form({ registryBlock: 'nope' })),
    ).toEqual({
      success: false,
      message: t('registryUnknownBlock'),
    });
  });

  it('pushes the fleet config when an upstream-error notification changes', async () => {
    const agent = await startFakeAgent();
    try {
      const pushes = agent.requests.length;
      await actions.updateRegistrySettingsAction(
        null,
        form({ registryBlock: 'notifications', [registry.notifyUpstreamErrors.key]: 'on' }),
      );

      await vi.waitFor(() => expect(agent.requests.length).toBeGreaterThan(pushes));
      expect(await stored(registry.notifyUpstreamErrors.key)).toBe(true);
    } finally {
      await agent.stop();
    }
  });
});

describe('CAPTCHA', () => {
  it('saves a provider with its secret encrypted, and keeps the secret on a blank re-save', async () => {
    const saved = await actions.updateCaptchaSettingsAction(
      null,
      form({ captchaProvider: 'turnstile', captchaSiteKey: 'site', captchaSecretKey: 'secret' }),
    );
    expect(saved).toEqual({ success: true, message: t('captchaSaved') });
    expect(decryptSecret((await stored('captcha')).secretKey)).toBe('secret');

    await actions.updateCaptchaSettingsAction(
      null,
      form({ captchaProvider: 'turnstile', captchaSiteKey: 'site2' }),
    );
    const again = await stored('captcha');
    expect(again.siteKey).toBe('site2');
    expect(decryptSecret(again.secretKey)).toBe('secret');
  });

  it('keeps the keys when turned off, so turning it back on is one click', async () => {
    await actions.updateCaptchaSettingsAction(
      null,
      form({ captchaProvider: 'turnstile', captchaSiteKey: 'site', captchaSecretKey: 'secret' }),
    );

    const result = await actions.updateCaptchaSettingsAction(
      null,
      form({ captchaProvider: 'none' }),
    );

    expect(result).toEqual({ success: true, message: t('captchaDisabled') });
    expect(await stored('captcha')).toMatchObject({ provider: 'none', siteKey: 'site' });
  });

  it('does not carry a secret across to another provider', async () => {
    await actions.updateCaptchaSettingsAction(
      null,
      form({ captchaProvider: 'turnstile', captchaSiteKey: 'site', captchaSecretKey: 'secret' }),
    );

    const result = await actions.updateCaptchaSettingsAction(
      null,
      form({ captchaProvider: 'hcaptcha', captchaSiteKey: 'site' }),
    );

    expect(result).toEqual({ success: false, message: t('captchaSecretKeyRequired') });
    expect((await stored('captcha')).provider).toBe('turnstile');
  });

  const REFUSALS: Array<[string, Record<string, string>, string]> = [
    [
      'no site key',
      { captchaProvider: 'turnstile', captchaSecretKey: 's' },
      'captchaSiteKeyRequired',
    ],
    [
      'a control character',
      { captchaProvider: 'turnstile', captchaSiteKey: 'a\u0007', captchaSecretKey: 's' },
      'captchaInvalid',
    ],
    [
      'a Cap instance that is no URL',
      {
        captchaProvider: 'cap',
        captchaSiteKey: 'k',
        captchaSecretKey: 's',
        captchaCapInstanceUrl: 'cap',
      },
      'captchaCapUrlRequired',
    ],
  ];
  for (const [name, fields, key] of REFUSALS) {
    it(`refuses ${name}`, async () => {
      expect(await actions.updateCaptchaSettingsAction(null, form(fields))).toEqual({
        success: false,
        message: t(key),
      });
      expect(await stored('captcha')).toBeUndefined();
    });
  }

  it('stores a Cap instance without its trailing slash', async () => {
    await actions.updateCaptchaSettingsAction(
      null,
      form({
        captchaProvider: 'cap',
        captchaSiteKey: 'k',
        captchaSecretKey: 's',
        captchaCapInstanceUrl: 'https://cap.example.com//',
      }),
    );

    expect((await stored('captcha')).capInstanceUrl).toBe('https://cap.example.com');
  });
});

describe('checking for updates now', () => {
  it('reports the newest release it found', async () => {
    globalThis.fetch = (async () =>
      Response.json({ tags: ['0.0.2', '0.0.1'] })) as unknown as typeof fetch;

    expect(await actions.checkForUpdatesAction()).toEqual({
      success: true,
      message: t('updatesLatest', { latest: '0.0.2' }),
    });
    expect(await stored('update_check')).toMatchObject({ latest: '0.0.2' });
  });

  it('reports why the check failed, and caches the failure', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;

    expect(await actions.checkForUpdatesAction()).toEqual({
      success: false,
      message: domainErrorMessage('registryRepositoryNotFound'),
    });
    expect(await stored('update_check')).toMatchObject({
      latest: null,
      errorCode: { code: 'registryRepositoryNotFound' },
    });
  });
});

describe('analytics', () => {
  let agent: FakeAgent;
  beforeEach(async () => {
    agent = await startFakeAgent();
  });
  afterEach(async () => {
    await agent.stop();
  });

  it('refuses to switch on without a ClickHouse password', async () => {
    const result = await actions.updateAnalyticsSettingsAction(
      null,
      form({ analyticsEnabled: 'on' }),
    );

    expect(result).toEqual({ success: false, message: t('analyticsPasswordRequired') });
    expect(await stored(registry.analyticsEnabled.key)).toBeUndefined();
  });

  it('asks the agent to start ClickHouse with the credentials, then to stop it', async () => {
    const on = await actions.updateAnalyticsSettingsAction(
      null,
      form({
        analyticsEnabled: 'on',
        clickhouseUrl: 'http://clickhouse:8123',
        clickhouseUser: 'cpm',
        clickhousePassword: 'ch-secret',
        clickhouseDb: 'analytics',
        clickhouseRetentionDays: '45',
      }),
    );

    expect(on).toEqual({ success: true, message: t('analyticsEnabled') });
    expect(isEncryptedSecret(await stored(registry.clickhousePassword.key))).toBe(true);
    expect(await stored(registry.clickhouseRetentionDays.key)).toBe(45);
    await vi.waitFor(() => expect(agent.desired?.services.services.clickhouse).toBe(true));
    expect(agent.desired?.services.env).toMatchObject({
      CLICKHOUSE_USER: 'cpm',
      CLICKHOUSE_PASSWORD: 'ch-secret',
      CLICKHOUSE_DB: 'analytics',
    });

    // The stored password stands in for the blank field the form sends back.
    const off = await actions.updateAnalyticsSettingsAction(
      null,
      form({
        hasPassword: 'yes',
        clickhouseUrl: 'http://clickhouse:8123',
        clickhouseUser: 'cpm',
        clickhouseDb: 'analytics',
        clickhouseRetentionDays: '45',
      }),
    );

    expect(off).toEqual({ success: true, message: t('analyticsDisabled') });
    await vi.waitFor(() => expect(agent.desired?.services.services.clickhouse).toBe(false));
    expect(decryptSecret(await stored(registry.clickhousePassword.key))).toBe('ch-secret');
  });

  it('saves an emptied database name as the default, and still stops ClickHouse', async () => {
    const connection = {
      clickhouseUrl: 'http://clickhouse:8123',
      clickhouseUser: 'cpm',
      clickhouseRetentionDays: '30',
    };
    await actions.updateAnalyticsSettingsAction(
      null,
      form({
        ...connection,
        analyticsEnabled: 'on',
        clickhousePassword: 'ch-secret',
        clickhouseDb: 'events',
      }),
    );
    await vi.waitFor(() => expect(agent.desired?.services.services.clickhouse).toBe(true));

    const off = await actions.updateAnalyticsSettingsAction(
      null,
      form({ ...connection, hasPassword: 'yes', clickhouseDb: '' }),
    );

    expect(off).toEqual({ success: true, message: t('analyticsDisabled') });
    expect(await stored(registry.clickhouseDb.key)).toBe('analytics');
    await vi.waitFor(() => expect(agent.desired?.services.services.clickhouse).toBe(false));
    expect(agent.desired?.services.env).toMatchObject({ CLICKHOUSE_DB: 'analytics' });
  });
});

describe('GeoIP', () => {
  it('says what is still missing before anything can download', async () => {
    expect(await actions.updateGeoipSettingsAction(null, form({ geoipEnabled: 'on' }))).toEqual({
      success: true,
      message: tSettings('geoipSavedNeedsCredentials'),
    });
    expect(await stored(registry.geoipEnabled.key)).toBe(true);

    expect(await actions.updateGeoipDatabasesAction()).toEqual({
      success: false,
      message: tSettings('geoipUpdateUnconfigured'),
    });
    expect(offline).not.toHaveBeenCalled();
  });

  it('refuses to download while off', async () => {
    expect(await actions.updateGeoipSettingsAction(null, form({}))).toEqual({
      success: true,
      message: tSettings('geoipSavedDisabled'),
    });

    expect(await actions.updateGeoipDatabasesAction()).toEqual({
      success: false,
      message: tSettings('geoipUpdateDisabled'),
    });
  });

  it('starts the download once it has credentials, and reports a failed one', async () => {
    const result = await actions.updateGeoipSettingsAction(
      null,
      form({
        geoipEnabled: 'on',
        geoipAccountId: '12345',
        geoipLicenseKey: 'licence',
        geoipUpdateIntervalHours: '12',
      }),
    );

    expect(result).toEqual({ success: true, message: tSettings('geoipSavedEnabled') });
    expect(isEncryptedSecret(await stored(registry.geoipLicenseKey.key))).toBe(true);
    expect(await stored(registry.geoipUpdateIntervalHours.key)).toBe(12);

    // Joins the download the save started rather than racing it.
    const check = await actions.updateGeoipDatabasesAction();

    expect(offline).toHaveBeenCalled();
    expect(check.success).toBe(false);
    expect(check.message).toContain('offline');
  });
});

describe('a non-administrator', () => {
  beforeEach(async () => {
    ctx.session = { user: await seedUser(ctx.db, 'user@example.com', 'user') };
  });

  it('is refused by every action that applies at once, and nothing is written', async () => {
    const refusals = await Promise.all([
      actions.updateRegistrySettingsAction(null, form({ registryBlock: 'instance' })),
      actions.updateCaptchaSettingsAction(null, form({ captchaProvider: 'none' })),
      actions.updateAnalyticsSettingsAction(null, form({})),
      actions.updateGeoipSettingsAction(null, form({})),
      actions.updateGeoipDatabasesAction(),
      actions.checkForUpdatesAction(),
    ]);

    for (const result of refusals) expect(result).toEqual(REFUSED);
    expect(await ctx.db.select().from(schemaModule.settings)).toEqual([]);
    expect(offline).not.toHaveBeenCalled();
  });

  it('cannot read what an administrator can', async () => {
    expect(await actions.lookupWafRuleMessageAction(942100)).toEqual({
      ok: false,
      error: domainErrorMessage('accessDenied'),
    });
    await expect(
      actions.testCrowdSecConnectionAction({ apiUrl: 'http://x', apiKey: 'k' }),
    ).resolves.toEqual(REFUSED);
  });
});
