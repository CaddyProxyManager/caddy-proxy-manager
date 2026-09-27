import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { settings } from '../../src/lib/db/schema';
import { createTestDbBefore, type TestDb } from '../helpers/db';

const SETTING = 'config:forward_auth_sequential_user_ids';
const NOW = '2026-09-27T12:00:00.000Z';
const INSERT_USER = `INSERT INTO users (email, role, status, "createdAt", "updatedAt")
  VALUES ('a@localhost', 'admin', 'active', '${NOW}', '${NOW}')`;

async function storedValue(db: TestDb): Promise<string | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTING));
  return row?.value;
}

describe('user UUID migration', () => {
  it('keeps numeric forward-auth ids for an install that already has users', async () => {
    const { db, exec, migrateRest } = await createTestDbBefore('user_uuid');
    await exec(INSERT_USER);
    await migrateRest();
    expect(await storedValue(db)).toBe('true');
  });

  it('leaves a fresh install on UUIDs', async () => {
    const { db, migrateRest } = await createTestDbBefore('user_uuid');
    await migrateRest();
    expect(await storedValue(db)).toBeUndefined();
  });

  it('does not overwrite a value already stored', async () => {
    const { db, exec, migrateRest } = await createTestDbBefore('user_uuid');
    await exec(INSERT_USER);
    await exec(
      `INSERT INTO settings (key, value, "updatedAt") VALUES ('${SETTING}', 'false', '${NOW}')`,
    );
    await migrateRest();
    expect(await storedValue(db)).toBe('false');
  });
});
