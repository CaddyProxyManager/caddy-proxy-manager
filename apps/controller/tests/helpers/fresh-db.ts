import { vi } from './vi';
import { fresh } from './fresh';

export type ReloadedDb = {
  dbModule: typeof import('@/src/lib/db');
  schema: typeof import('@/src/lib/db/schema');
};

/**
 * Reloads schema, connection and db together (db alone keeps the cached connection) and repoints
 * the plain specifiers. Prefer the returned namespaces: a later reload moves the plain ones. Set
 * DATABASE_URL and clear __DRIZZLE_DB__/__DB_CLIENT__/__MIGRATIONS_RAN__ first.
 */
export async function reloadDbModule(): Promise<ReloadedDb> {
  const schema = (await import(
    `@/src/lib/db/schema${fresh()}`
  )) as typeof import('@/src/lib/db/schema');
  vi.mock('@/src/lib/db/schema', () => ({ ...schema }));

  const connection = await import(`@/src/lib/db/connection${fresh()}`);
  vi.mock('@/src/lib/db/connection', () => ({ ...connection }));

  const dbModule = (await import(`@/src/lib/db${fresh()}`)) as typeof import('@/src/lib/db');
  vi.mock('@/src/lib/db', () => ({ ...dbModule }));

  return { dbModule, schema };
}
