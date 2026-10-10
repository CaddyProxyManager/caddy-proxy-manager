/**
 * The certificate editor's DNS provider field, through the server actions and the real model: a
 * chosen provider is stored, the default choice clears it, and a form without the field (the
 * import dialog) leaves it alone.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig: vi.fn(async () => {}) }));

import { eq } from 'drizzle-orm';
import {
  createCertificateAction,
  updateCertificateAction,
} from '@/src/app/(dashboard)/certificates/actions';
import { unwrap } from '@/src/lib/errors/action-result';
import { certificates, users } from '../../../src/lib/db/schema';

const NOW = '2026-03-01T00:00:00.000Z';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

async function storedOptions(id: number) {
  const [row] = await ctx.db.select().from(certificates).where(eq(certificates.id, id));
  return row.providerOptions;
}

beforeAll(async () => {
  await ctx.db.insert(users).values({
    id: 1,
    email: 'admin@example.com',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('the DNS provider field', () => {
  it('stores the chosen provider, clears on the default choice and keeps it when absent', async () => {
    unwrap(
      await createCertificateAction(
        form({
          type: 'managed',
          name: 'Managed',
          domain_names: '*.example.com',
          auto_renew: 'on',
          dns_provider: 'cloudflare',
        }),
      ),
    );
    const [row] = await ctx.db.select().from(certificates).where(eq(certificates.name, 'Managed'));
    expect(row.type).toBe('managed');
    expect(row.providerOptions).toBe('{"provider":"cloudflare"}');

    // The import dialog never shows the field.
    unwrap(await updateCertificateAction(row.id, form({ name: 'Renamed' })));
    expect(await storedOptions(row.id)).toBe('{"provider":"cloudflare"}');

    unwrap(
      await updateCertificateAction(
        row.id,
        form({ type: 'managed', dns_provider_present: '1', dns_provider: 'route53' }),
      ),
    );
    expect(await storedOptions(row.id)).toBe('{"provider":"route53"}');

    unwrap(
      await updateCertificateAction(
        row.id,
        form({ type: 'managed', dns_provider_present: '1', dns_provider: '' }),
      ),
    );
    expect(await storedOptions(row.id)).toBeNull();
  });

  it('ignores the field on an imported certificate', async () => {
    const { createSelfSignedServerCertificate } = await import('../../helpers/certs');
    const pair = createSelfSignedServerCertificate('pair.example.com', ['pair.example.com']);
    unwrap(
      await createCertificateAction(
        form({
          type: 'imported',
          name: 'Imported',
          domain_names: 'pair.example.com',
          certificate_pem: pair.certificatePem,
          private_key_pem: pair.privateKeyPem,
          dns_provider: 'cloudflare',
        }),
      ),
    );
    const [row] = await ctx.db.select().from(certificates).where(eq(certificates.name, 'Imported'));
    expect(row.providerOptions).toBeNull();
  });
});
