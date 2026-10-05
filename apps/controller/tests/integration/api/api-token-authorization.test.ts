import type { SQL } from 'bun';
import { afterEach, describe, expect, it } from 'bun:test';
import { createTestDatabase } from '@/tests/helpers/db';
import { TEST_ENV } from '@/tests/helpers/env';
import { reloadDbModule } from '@/tests/helpers/fresh-db';

function resetDbModuleState() {
  delete (globalThis as typeof globalThis & { __DRIZZLE_DB__?: unknown }).__DRIZZLE_DB__;
  delete (globalThis as typeof globalThis & { __DB_CLIENT__?: unknown }).__DB_CLIENT__;
  delete (globalThis as typeof globalThis & { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__;
}

afterEach(() => {
  // Back to the suite-wide database, not deleted: connection.ts throws at import without one.
  process.env.DATABASE_URL = TEST_ENV.DATABASE_URL;
  resetDbModuleState();
});

describe('API token deletion authorization', () => {
  it("makes another user's token indistinguishable from a nonexistent ID", async () => {
    // Not a per-test schema: the real db module opens its own connection from DATABASE_URL.
    const database = await createTestDatabase();

    try {
      process.env.DATABASE_URL = database.url;
      resetDbModuleState();

      // Bun cannot drop a cached module, so a unique specifier re-evaluates db against this file
      // and rewrites every consumer's live bindings.
      const { dbModule: freshDb } = await reloadDbModule();
      const { default: db, nowIso } = freshDb;
      const [{ apiTokens, users }, { deleteApiToken }] = await Promise.all([
        import('@/src/lib/db/schema'),
        import('@/src/lib/models/api-tokens'),
      ]);
      const now = nowIso();
      const [owner, otherUser, admin] = await db
        .insert(users)
        .values([
          {
            email: 'owner@example.com',
            name: 'Owner',
            role: 'user',
            provider: 'credentials',
            subject: 'owner',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          {
            email: 'other@example.com',
            name: 'Other',
            role: 'user',
            provider: 'credentials',
            subject: 'other',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          {
            email: 'admin@example.com',
            name: 'Admin',
            role: 'admin',
            provider: 'credentials',
            subject: 'admin',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ])
        .returning();
      const [token] = await db
        .insert(apiTokens)
        .values({
          name: 'Owner token',
          tokenHash: 'a'.repeat(64),
          createdBy: owner.id,
          createdAt: now,
        })
        .returning();

      await expect(deleteApiToken(token.id, otherUser.id, false)).rejects.toMatchObject({
        name: 'NotFoundError',
        message: 'Token not found',
      });
      await expect(deleteApiToken(token.id + 10_000, otherUser.id, false)).rejects.toMatchObject({
        name: 'NotFoundError',
        message: 'Token not found',
      });
      expect(
        await db.query.apiTokens.findFirst({
          where: (table, { eq }) => eq(table.id, token.id),
        }),
      ).toBeDefined();

      await deleteApiToken(token.id, admin.id, true);
      expect(
        await db.query.apiTokens.findFirst({
          where: (table, { eq }) => eq(table.id, token.id),
        }),
      ).toBeUndefined();

      // $client is the raw driver handle, `unknown` on the shared type.
      await (db.$client as SQL).close();
    } finally {
      await database.drop();
    }
  });
});
