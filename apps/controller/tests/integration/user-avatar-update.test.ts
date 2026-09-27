/**
 * Regression: removing a profile picture must actually remove it. updateUserProfile wrote
 * `data.avatarUrl ?? current.avatarUrl`, which cannot tell "not supplied" from "cleared".
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Outside the factory: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    sqlite: undefined,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (value: string | Date | null | undefined): string | null =>
      !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  };
});

import { users } from '../../src/lib/db/schema';
import { createUser, updateUserProfile } from '../../src/lib/models/user';

const ICON = 'data:image/png;base64,AAAA';

beforeEach(async () => {
  await ctx.db.delete(users);
});

async function seedUser() {
  return createUser({
    email: 'ada@example.com',
    name: 'Ada',
    provider: 'credentials',
    subject: 'ada',
    avatarUrl: ICON,
  });
}

describe('updateUserProfile - avatar', () => {
  it('clears the icon when passed null', async () => {
    const user = await seedUser();
    expect(user.avatarUrl).toBe(ICON);

    const updated = await updateUserProfile(user.id, { avatarUrl: null });

    expect(updated?.avatarUrl).toBeNull();
  });

  it('keeps the icon when the field is not supplied', async () => {
    const user = await seedUser();

    const updated = await updateUserProfile(user.id, { name: 'Ada Lovelace' });

    expect(updated?.avatarUrl).toBe(ICON);
    expect(updated?.name).toBe('Ada Lovelace');
  });

  it('replaces the icon when passed a new one', async () => {
    const user = await seedUser();

    const updated = await updateUserProfile(user.id, { avatarUrl: 'data:image/png;base64,BBBB' });

    expect(updated?.avatarUrl).toBe('data:image/png;base64,BBBB');
  });

  it('leaves other fields untouched when only clearing the icon', async () => {
    const user = await seedUser();

    const updated = await updateUserProfile(user.id, { avatarUrl: null });

    expect(updated?.email).toBe('ada@example.com');
    expect(updated?.name).toBe('Ada');
  });
});
