/** Time zone and number format, stored on the account. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { getDisplayPreferences, setDisplayPreferences } from '@/src/lib/users/display-preferences';
import { numberLocaleFor } from '@/src/lib/locale/number-format';
import { DomainError } from '@/src/lib/errors/domain-error';
import { users } from '../../../src/lib/db/schema';

let userId: number;

beforeEach(async () => {
  await ctx.db.delete(users);
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(users)
    .values({ email: 'reader@example.com', role: 'user', createdAt: now, updatedAt: now })
    .returning({ id: users.id });
  userId = row.id;
});

describe('display preferences', () => {
  it('default to the browser zone and the language digits', async () => {
    expect(await getDisplayPreferences(userId)).toEqual({ timeZone: null, numberFormat: 'auto' });
  });

  it('store a zone and a number format, and clear them again', async () => {
    await setDisplayPreferences(userId, {
      timeZone: 'Europe/Berlin',
      numberFormat: 'apostrophe-dot',
    });
    expect(await getDisplayPreferences(userId)).toEqual({
      timeZone: 'Europe/Berlin',
      numberFormat: 'apostrophe-dot',
    });
    await setDisplayPreferences(userId, { timeZone: null, numberFormat: 'auto' });
    expect(await getDisplayPreferences(userId)).toEqual({ timeZone: null, numberFormat: 'auto' });
  });

  it('refuse an unknown zone or format', async () => {
    const codeOf = async (input: { timeZone: unknown; numberFormat: unknown }) => {
      try {
        await setDisplayPreferences(userId, input);
        return null;
      } catch (error) {
        return error instanceof DomainError ? error.code : 'other';
      }
    };
    expect(await codeOf({ timeZone: 'Mars/Olympus', numberFormat: 'auto' })).toBe(
      'timeZoneInvalid',
    );
    expect(await codeOf({ timeZone: null, numberFormat: 'roman' })).toBe('numberFormatInvalid');
  });
});

describe('numberLocaleFor', () => {
  it('groups as chosen, and leaves "auto" to the page language', () => {
    expect(numberLocaleFor('auto')).toBeNull();
    expect(numberLocaleFor(null)).toBeNull();
    expect(new Intl.NumberFormat(numberLocaleFor('dot-comma') ?? 'en').format(1234.5)).toBe(
      '1.234,5',
    );
    expect(new Intl.NumberFormat(numberLocaleFor('comma-dot') ?? 'de').format(1234.5)).toBe(
      '1,234.5',
    );
  });
});
