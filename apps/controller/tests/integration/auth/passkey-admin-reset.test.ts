/**
 * An administrator removes another user's passkeys, as with a 2FA reset: sessions end too, the
 * change is audited, and nobody removes their own this way.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, actorId: 1 }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  requireUser: vi.fn(async () => ({ user: { id: String(ctx.actorId), role: 'admin' } })),
}));

import { eq } from 'drizzle-orm';
import { removeUserPasskeysAction } from '@/src/app/(dashboard)/users/actions';
import { logAuditEvent } from '@/src/lib/audit';
import { passkeys, sessions, users } from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();

async function seedUser(email: string): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({ email, role: 'user', status: 'active', createdAt: NOW, updatedAt: NOW })
    .returning({ id: users.id });
  await ctx.db.insert(passkeys).values({
    userId: row.id,
    publicKey: 'cose',
    credentialID: `credential-${email}`,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    createdAt: NOW,
  });
  await ctx.db.insert(sessions).values({
    userId: row.id,
    token: `session-${email}`,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return row.id;
}

beforeEach(() => {
  vi.mocked(logAuditEvent).mockClear();
});

describe('removeUserPasskeysAction', () => {
  it('removes every passkey, ends the sessions and audits it', async () => {
    ctx.actorId = await seedUser('admin-remover@example.com');
    const target = await seedUser('lost-phone@example.com');

    const result = await removeUserPasskeysAction(target);

    expect(result.status).toBe('success');
    expect(await ctx.db.select().from(passkeys).where(eq(passkeys.userId, target))).toHaveLength(0);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, target))).toHaveLength(0);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'passkey_removed',
        entityId: target,
        summary: 'Passkeys removed for user lost-phone@example.com by an administrator',
      }),
    );
  });

  it('refuses an administrator their own', async () => {
    ctx.actorId = await seedUser('self@example.com');

    const result = await removeUserPasskeysAction(ctx.actorId);

    expect(result.status).toBe('error');
    expect(
      await ctx.db.select().from(passkeys).where(eq(passkeys.userId, ctx.actorId)),
    ).toHaveLength(1);
  });
});
