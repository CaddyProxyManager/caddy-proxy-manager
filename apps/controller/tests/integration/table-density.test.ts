/** Read on every navigation, so an unreadable row must fall back rather than throw. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '../helpers/next-intl';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  userId: '7',
}));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// A Bun mock factory must be synchronous; an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/src/lib/auth', () => ({
  requireUser: async () => ({ user: { id: ctx.userId, role: 'viewer' } }),
}));

import { getTableDensity, setTableDensity } from '../../src/lib/models/table-density';
import { saveTableDensityAction } from '../../src/app/(dashboard)/profile/display-actions';
import { settings } from '../../src/lib/db/schema';

beforeEach(async () => {
  ctx.userId = '7';
  await ctx.db.delete(settings);
});

describe('table density', () => {
  it('is balanced for a user who never chose', async () => {
    expect(await getTableDensity(7)).toBe('balanced');
  });

  it("keeps each user's choice apart", async () => {
    await setTableDensity(7, 'compact');
    await setTableDensity(8, 'spacious');

    expect(await getTableDensity(7)).toBe('compact');
    expect(await getTableDensity(8)).toBe('spacious');
  });

  it('falls back rather than throwing on a value it does not know', async () => {
    await ctx.db.insert(settings).values({
      key: 'ui:table_density:7',
      value: 'enormous',
      updatedAt: new Date().toISOString(),
    });

    expect(await getTableDensity(7)).toBe('balanced');
  });

  it('is saved by any signed-in user, for themselves only', async () => {
    // A viewer: this is a personal display choice, not a permission.
    const result = await saveTableDensityAction('compact');

    expect(result.ok).toBe(true);
    expect(await getTableDensity(7)).toBe('compact');
    expect(await getTableDensity(8)).toBe('balanced');
  });

  it('refuses a value that is not a density, since an action takes any string', async () => {
    const result = await saveTableDensityAction('enormous');

    expect(result.ok).toBe(false);
    expect(await getTableDensity(7)).toBe('balanced');
  });
});
