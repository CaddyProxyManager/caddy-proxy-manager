/** The certificate alert pass against a real database: what it reads, who it tells, and when. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { certificates, settings, users } from '../../src/lib/db/schema';
import {
  getCertificateAlertState,
  runCertificateExpiryAlerts,
} from '../../src/lib/email/certificate-alerts';
import { type OutgoingEmail, setEmailDeliveryForTests } from '../../src/lib/email/transport';
import { createUser } from '../../src/lib/models/user';
import { invalidateSettingsCache } from '../../src/lib/settings/resolve';
import { createSelfSignedServerCertificate } from '../helpers/certs';

const TOUCHED_ENV = [
  'SMTP_HOST',
  'SMTP_FROM',
  'EMAIL_ALERT_RECIPIENTS',
  'CERTIFICATE_EXPIRY_ALERT_DAYS',
];
let sent: OutgoingEmail[] = [];

async function importCertificate(name: string, validityDays: number) {
  const { certificatePem } = createSelfSignedServerCertificate(name, [name], validityDays);
  const now = new Date().toISOString();
  await ctx.db.insert(certificates).values({
    name,
    type: 'imported',
    domainNames: JSON.stringify([name]),
    autoRenew: false,
    certificatePem,
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'proxy@example.com';
  invalidateSettingsCache();
  sent = [];
  setEmailDeliveryForTests(async (_config, message) => {
    sent.push(message);
  });
  await ctx.db.delete(certificates);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
});

afterAll(() => {
  setEmailDeliveryForTests(null);
  for (const name of TOUCHED_ENV) delete process.env[name];
});

describe('runCertificateExpiryAlerts', () => {
  it('emails the administrators about an imported certificate once', async () => {
    await createUser({
      email: 'ops@example.com',
      role: 'admin',
      provider: 'credentials',
      subject: 'a',
    });
    // Undeliverable, as setup names the first administrator, so left off the list.
    await createUser({
      email: 'root@localhost',
      role: 'admin',
      provider: 'credentials',
      subject: 'b',
    });
    await createUser({
      email: 'user@example.com',
      role: 'user',
      provider: 'credentials',
      subject: 'c',
    });
    await importCertificate('soon.example.com', 5);
    await importCertificate('later.example.com', 60);

    expect(await runCertificateExpiryAlerts()).toEqual({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['ops@example.com']);
    expect(sent[0].subject).toBe('A certificate needs attention on Caddy Proxy Manager');
    expect(sent[0].text).toContain('soon.example.com (imported) expires on');
    expect(sent[0].text).not.toContain('later.example.com');

    expect(await runCertificateExpiryAlerts()).toEqual({ sent: 0 });
    expect(sent).toHaveLength(1);
    const state = await getCertificateAlertState();
    expect(state.error).toBeNull();
    expect(Object.values(state.alerted)).toEqual(['expiring']);
  });

  it('sends to the configured recipients instead, and not at all with a threshold of 0', async () => {
    process.env.EMAIL_ALERT_RECIPIENTS = 'a@example.com, b@example.com';
    await importCertificate('soon.example.com', 2);

    process.env.CERTIFICATE_EXPIRY_ALERT_DAYS = '0';
    expect(await runCertificateExpiryAlerts()).toEqual({ skipped: 'disabled' });

    process.env.CERTIFICATE_EXPIRY_ALERT_DAYS = '14';
    expect(await runCertificateExpiryAlerts()).toEqual({ sent: 1 });
    expect(sent[0].to).toEqual(['a@example.com', 'b@example.com']);
  });

  it('records a failed send and retries it on the next pass', async () => {
    process.env.EMAIL_ALERT_RECIPIENTS = 'a@example.com';
    await importCertificate('soon.example.com', 2);
    setEmailDeliveryForTests(async () => {
      throw new Error('421 try later');
    });

    await expect(runCertificateExpiryAlerts()).rejects.toThrow();
    expect((await getCertificateAlertState()).error).toContain('421 try later');

    setEmailDeliveryForTests(async (_config, message) => {
      sent.push(message);
    });
    expect(await runCertificateExpiryAlerts()).toEqual({ sent: 1 });
    expect((await getCertificateAlertState()).error).toBeNull();
  });
});
