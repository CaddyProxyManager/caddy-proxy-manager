/** Shared by the tests driving Settings server actions against a real database. */
import { and, eq } from 'drizzle-orm';
import { settings, settingsStaged, users } from '../../src/lib/db/schema';
import type { TestDb } from './db';

export type SessionUser = { id: string; email: string; name: string; role: string };

/** A repeated name (a header list) takes an array. */
export function form(fields: Record<string, string | string[]> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(name, item);
  }
  return data;
}

/** Real rows: staged settings, revisions and audit events all reference a user. */
export async function seedUser(db: TestDb, email: string, role: string): Promise<SessionUser> {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(users)
    .values({
      email,
      name: role,
      role,
      provider: 'credentials',
      subject: email,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: users.id });
  return { id: String(row.id), email, name: role, role };
}

export async function storedSetting(db: TestDb, key: string): Promise<any> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row ? JSON.parse(row.value) : undefined;
}

/** `userId`'s pending value, parsed; undefined when nothing is staged. */
export async function stagedSetting(db: TestDb, userId: string, key: string): Promise<any> {
  const [row] = await db
    .select({ value: settingsStaged.value })
    .from(settingsStaged)
    .where(and(eq(settingsStaged.userId, Number(userId)), eq(settingsStaged.key, key)));
  return row ? JSON.parse(row.value) : undefined;
}

export async function stagedKeys(db: TestDb): Promise<string[]> {
  const rows = await db.select({ key: settingsStaged.key }).from(settingsStaged);
  return rows.map((row) => row.key).sort();
}
