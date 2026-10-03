/** A generated CA names this instance, not the product, in its subject's O=. */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));

import { internalCaSubject } from '../../src/lib/ca-subject';
import { appName } from '../../src/lib/settings/registry';
import { invalidateSettingsCache, saveSettings } from '../../src/lib/settings/resolve';
import * as schema from '../../src/lib/db/schema';

beforeEach(async () => {
  await ctx.db.delete(schema.settings);
  invalidateSettingsCache();
});

describe('internalCaSubject', () => {
  it('uses the instance name for the organization', async () => {
    await saveSettings({ [appName.key]: 'Acme Proxies' });
    expect(await internalCaSubject('Acme Root CA')).toEqual([
      { name: 'commonName', value: 'Acme Root CA' },
      { name: 'organizationName', value: 'Acme Proxies' },
    ]);
  });

  it('falls back to the product name when none is set', async () => {
    const subject = await internalCaSubject('Root');
    expect(subject[1]).toEqual({ name: 'organizationName', value: 'Caddy Proxy Manager' });
  });
});
