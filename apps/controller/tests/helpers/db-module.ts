import * as schema from '../../src/lib/db/schema';
import { currentDb, type TestDb, testDialect } from './db';

type DbModule = typeof import('../../src/lib/db');

/**
 * The whole `src/lib/db` module on a test's database: `vi.mock('.../src/lib/db', () =>
 * dbModuleMock(() => ctx.db))`. The preload has already loaded the real module, so Bun patches
 * its exports in place and a name a factory leaves out keeps the real one - whose
 * `runInTransaction` writes to the app's own connection, not the test's. Typed as the module, so
 * a new export fails typecheck here; tests/unit/db/db-module-mock.test.ts checks the runtime names.
 */
export function dbModuleMock(current: () => TestDb, overrides: Partial<DbModule> = {}): DbModule {
  const db = currentDb(current);
  return {
    default: db,
    db,
    client: currentDb(() => current().$client as TestDb) as unknown as DbModule['client'],
    schema,
    nowIso: () => new Date().toISOString(),
    toIso: (value) =>
      !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
    // A real transaction, as in src/lib/db/connection.ts, so a failing statement rolls back.
    runInTransaction: async (build) => {
      const handle = current() as any;
      if (testDialect === 'sqlite') {
        handle.transaction((tx: unknown) => {
          for (const statement of build(tx)) statement.run?.();
        });
        return;
      }
      await handle.transaction(async (tx: unknown) => {
        for (const statement of build(tx)) await statement;
      });
    },
    ...overrides,
  };
}
