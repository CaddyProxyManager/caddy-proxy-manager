/**
 * The legacy Cloudflare token is stored encrypted, but rows written before that hold plaintext and
 * must keep working until their next save encrypts them.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted out of the factory: a Bun mock factory must be synchronous, or the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));

import { eq } from 'drizzle-orm';
import { settings } from '../../src/lib/db/schema';
import { getCloudflareSettings, saveCloudflareSettings } from '../../src/lib/settings';
import { decryptSecret, isEncryptedSecret } from '../../src/lib/secret';
import { redactLegacyCloudflareSettingsForApi } from '../../src/lib/dns-providers';

async function storedCloudflare(): Promise<{ apiToken: string; zoneId?: string }> {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, 'cloudflare'));
  return JSON.parse(row.value);
}

beforeEach(async () => {
  await ctx.db.delete(settings);
});

describe('the legacy Cloudflare API token', () => {
  it('is stored encrypted, with the rest of the settings left readable', async () => {
    await saveCloudflareSettings({ apiToken: 'cf-token-123', zoneId: 'zone-1' });

    const stored = await storedCloudflare();
    expect(isEncryptedSecret(stored.apiToken)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('cf-token-123');
    expect(decryptSecret(stored.apiToken)).toBe('cf-token-123');
    expect(stored.zoneId).toBe('zone-1');
  });

  it('is not encrypted twice when the stored value is saved back', async () => {
    await saveCloudflareSettings({ apiToken: 'cf-token-123' });
    await saveCloudflareSettings((await getCloudflareSettings())!);

    expect(decryptSecret((await storedCloudflare()).apiToken)).toBe('cf-token-123');
  });

  it('still reads a token saved before encryption, and encrypts it on the next save', async () => {
    await ctx.db.insert(settings).values({
      key: 'cloudflare',
      value: JSON.stringify({ apiToken: 'legacy-plaintext' }),
      updatedAt: new Date().toISOString(),
    });

    const legacy = await getCloudflareSettings();
    expect(redactLegacyCloudflareSettingsForApi(legacy!)).toEqual({ hasApiToken: true });

    await saveCloudflareSettings(legacy!);

    const stored = await storedCloudflare();
    expect(isEncryptedSecret(stored.apiToken)).toBe(true);
    expect(decryptSecret(stored.apiToken)).toBe('legacy-plaintext');
  });

  it('stores a cleared token as empty rather than as ciphertext of nothing', async () => {
    await saveCloudflareSettings({ apiToken: '' });

    expect((await storedCloudflare()).apiToken).toBe('');
  });
});
