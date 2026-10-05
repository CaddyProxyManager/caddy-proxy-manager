/**
 * Settings -> Email: the SMTP form, the notification recipients, and the two test buttons. Saves
 * apply at once (nothing for Caddy to reload); mail goes through the transport's test seam, so
 * what would have been sent is what is asserted on.
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

ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  auth: vi.fn(async () => ctx.session),
}));

import {
  sendTestEmailAction,
  sendTestNotificationAction,
  updateCertificateAlertSettingsAction,
  updateEmailSettingsAction,
} from '@/src/app/(dashboard)/settings/actions';
import { domainErrorMessage } from '@/src/lib/errors/domain-error';
import { type OutgoingEmail, setEmailDeliveryForTests } from '@/src/lib/email/transport';
import { decryptSecret, isEncryptedSecret } from '@/src/lib/secrets';
import * as registry from '@/src/lib/settings/registry';
import { invalidateSettingsCache } from '@/src/lib/settings/resolve';
import { testTranslator } from '../../helpers/next-intl';
import { type SessionUser, form, seedUser, storedSetting } from '../../helpers/settings-actions';

const t = testTranslator('settings.email');
const SAVED = { success: true, message: t('saved') };

let admin: SessionUser;
let sent: OutgoingEmail[];

const stored = (key: string) => storedSetting(ctx.db, key);

const SMTP = {
  smtpEnabled: 'on',
  smtpHost: 'smtp.example.com',
  smtpPort: '587',
  smtpSecurity: 'starttls',
  smtpUsername: 'mailer',
  smtpPassword: 'smtp-secret',
  smtpFrom: 'proxy@example.com',
};

beforeEach(async () => {
  ctx.db = await createTestDb();
  invalidateSettingsCache();
  // `@localhost`, as setup names the first administrator: no deliverable address to fall back on.
  admin = await seedUser(ctx.db, 'admin@localhost', 'admin');
  ctx.session = { user: admin };
  sent = [];
  setEmailDeliveryForTests(async (_config, message) => {
    sent.push(message);
  });
});

afterEach(() => {
  setEmailDeliveryForTests(null);
});

describe('the SMTP form', () => {
  it('saves the server with its password encrypted', async () => {
    expect(await updateEmailSettingsAction(null, form(SMTP))).toEqual(SAVED);

    expect(await stored(registry.smtpEnabled.key)).toBe(true);
    expect(await stored(registry.smtpHost.key)).toBe('smtp.example.com');
    expect(await stored(registry.smtpPort.key)).toBe(587);
    const password = await stored(registry.smtpPassword.key);
    expect(isEncryptedSecret(password)).toBe(true);
    expect(decryptSecret(password)).toBe('smtp-secret');
  });

  it('keeps the stored password when the field comes back blank', async () => {
    await updateEmailSettingsAction(null, form(SMTP));
    await updateEmailSettingsAction(null, form({ ...SMTP, smtpPassword: '', smtpPort: '465' }));

    expect(await stored(registry.smtpPort.key)).toBe(465);
    expect(decryptSecret(await stored(registry.smtpPassword.key))).toBe('smtp-secret');
  });

  it('drops the password once there is no username to send it with', async () => {
    await updateEmailSettingsAction(null, form(SMTP));
    await updateEmailSettingsAction(null, form({ ...SMTP, smtpUsername: ' ', smtpPassword: '' }));

    expect(await stored(registry.smtpPassword.key)).toBe('');
  });

  it('writes nothing when a field is out of range', async () => {
    const result = await updateEmailSettingsAction(null, form({ ...SMTP, smtpPort: '70000' }));

    expect(result.success).toBe(false);
    expect(result.message).toContain('65535');
    expect(await stored(registry.smtpHost.key)).toBeUndefined();
  });

  it('switches mail off explicitly rather than back to "infer from the host"', async () => {
    await updateEmailSettingsAction(null, form({ ...SMTP, smtpEnabled: '' }));

    expect(await stored(registry.smtpEnabled.key)).toBe(false);
  });
});

describe('the notification recipients', () => {
  it('saves the recipients and the alert window', async () => {
    const result = await updateCertificateAlertSettingsAction(
      null,
      form({ alertRecipients: 'ops@example.com, sec@example.com', alertDays: '21' }),
    );

    expect(result).toEqual(SAVED);
    expect(await stored(registry.emailAlertRecipients.key)).toBe(
      'ops@example.com, sec@example.com',
    );
    expect(await stored(registry.certificateExpiryAlertDays.key)).toBe(21);
  });

  it('refuses an alert window past its limit', async () => {
    const result = await updateCertificateAlertSettingsAction(
      null,
      form({ alertRecipients: '', alertDays: '365' }),
    );

    expect(result.success).toBe(false);
    expect(await stored(registry.certificateExpiryAlertDays.key)).toBeUndefined();
  });
});

describe('sending a test email', () => {
  it('says email is not set up before anything is saved', async () => {
    expect(await sendTestEmailAction('ops@example.com')).toEqual({
      success: false,
      message: domainErrorMessage('emailNotConfigured'),
    });
    expect(sent).toEqual([]);
  });

  it('sends to the address given, from the saved sender', async () => {
    await updateEmailSettingsAction(null, form(SMTP));

    expect(await sendTestEmailAction(' ops@example.com ')).toEqual({
      success: true,
      message: t('testSent', { email: 'ops@example.com' }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ops@example.com');
    expect(sent[0].from.address).toBe('proxy@example.com');
  });

  it("falls back to the administrator's own address", async () => {
    await updateEmailSettingsAction(null, form(SMTP));
    ctx.session = { user: await seedUser(ctx.db, 'root@example.com', 'admin') };

    await sendTestEmailAction('');

    expect(sent.map((message) => message.to)).toEqual(['root@example.com']);
  });

  it('refuses an address that is not one', async () => {
    await updateEmailSettingsAction(null, form(SMTP));

    expect(await sendTestEmailAction('nope')).toEqual({
      success: false,
      message: t('testInvalidRecipient'),
    });
    expect(sent).toEqual([]);
  });

  it("passes on the server's refusal", async () => {
    await updateEmailSettingsAction(null, form(SMTP));
    setEmailDeliveryForTests(async () => {
      throw new Error('550 relay denied');
    });

    expect(await sendTestEmailAction('ops@example.com')).toEqual({
      success: false,
      message: domainErrorMessage('emailSendFailed', { detail: '550 relay denied' }),
    });
  });
});

describe('sending a test notification', () => {
  it('goes to the configured recipients', async () => {
    await updateEmailSettingsAction(null, form(SMTP));
    await updateCertificateAlertSettingsAction(
      null,
      form({ alertRecipients: 'ops@example.com, sec@example.com', alertDays: '14' }),
    );

    const result = await sendTestNotificationAction();

    expect(result).toEqual({
      success: true,
      message: t('testNotificationSent', { recipients: 'ops@example.com and sec@example.com' }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['ops@example.com', 'sec@example.com']);
  });

  it('says there is no one to send it to', async () => {
    await updateEmailSettingsAction(null, form(SMTP));

    expect(await sendTestNotificationAction()).toEqual({
      success: false,
      message: t('testNotificationNoRecipients'),
    });
    expect(sent).toEqual([]);
  });

  it('says why it could not be sent', async () => {
    await updateCertificateAlertSettingsAction(
      null,
      form({ alertRecipients: 'ops@example.com', alertDays: '14' }),
    );

    expect(await sendTestNotificationAction()).toEqual({
      success: false,
      message: domainErrorMessage('emailNotConfigured'),
    });
  });
});

describe('a non-administrator', () => {
  it('can neither change the mail settings nor send through them', async () => {
    await updateEmailSettingsAction(null, form(SMTP));
    ctx.session = { user: await seedUser(ctx.db, 'user@example.com', 'user') };
    const refused = { success: false, message: domainErrorMessage('adminRequired') };

    expect(await updateEmailSettingsAction(null, form({ ...SMTP, smtpHost: 'evil.test' }))).toEqual(
      refused,
    );
    expect(
      await updateCertificateAlertSettingsAction(null, form({ alertRecipients: 'x@evil.test' })),
    ).toEqual(refused);
    expect(await sendTestEmailAction('x@evil.test')).toEqual(refused);
    expect(await sendTestNotificationAction()).toEqual(refused);
    expect(await stored(registry.smtpHost.key)).toBe('smtp.example.com');
    expect(sent).toEqual([]);
  });
});
