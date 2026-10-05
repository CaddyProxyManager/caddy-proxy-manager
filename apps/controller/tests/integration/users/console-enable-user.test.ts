/**
 * `cpm-server --enable-user`: the console recovery for an account disabled after failed sign-ins,
 * which also starts its count over.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { POST } from '@/src/app/api/internal/enable-user/route';
import { logAuditEvent } from '@/src/lib/audit';
import { config } from '@/src/lib/config';
import { signConsoleCommand } from '@/src/lib/users/console-command';
import { PEER_ADDRESS_HEADER } from '@/src/lib/http/peer-address';
import {
  accountFailureCount,
  accountKey,
  DEFAULT_ACCOUNT_LOCK,
  registerAccountFailure,
} from '@/src/lib/auth/rate-limit';
import { users } from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();
const STAMPED = Symbol.for('cpm.peer-address-stamped');
const flags = globalThis as Record<symbol, unknown>;

async function seedUser(username: string, status: string): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email: `${username}@localhost`,
      username,
      role: 'admin',
      status,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: users.id });
  return row.id;
}

function request(
  username: string,
  options: { peer?: string; secret?: string; purpose?: 'enable-user' | 'reset-2fa' } = {},
) {
  const timestamp = Date.now();
  return new NextRequest('http://localhost/api/internal/enable-user', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PEER_ADDRESS_HEADER]: options.peer ?? '127.0.0.1',
    },
    body: JSON.stringify({
      username,
      timestamp,
      signature: signConsoleCommand(
        options.secret ?? config.sessionSecret,
        username,
        timestamp,
        options.purpose ?? 'enable-user',
      ),
    }),
  });
}

const statusOf = async (id: number) =>
  (await ctx.db.select().from(users).where(eq(users.id, id)))[0].status;

beforeEach(async () => {
  flags[STAMPED] = true;
  vi.mocked(logAuditEvent).mockClear();
  await ctx.db.delete(users);
});

afterAll(() => {
  delete flags[STAMPED];
});

describe('POST /api/internal/enable-user', () => {
  it('enables the user, starts the count over, and audits it with no actor', async () => {
    const id = await seedUser('only-admin', 'disabled');
    const policy = { ...DEFAULT_ACCOUNT_LOCK, disableAfter: 3 };
    for (let i = 0; i < 3; i++)
      await registerAccountFailure(accountKey('only-admin'), Date.now(), policy);

    const response = await POST(request('Only-Admin'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: 'only-admin@localhost', wasDisabled: true });
    expect(await statusOf(id)).toBe('active');
    expect(accountFailureCount(accountKey('only-admin'))).toBe(0);
    expect(vi.mocked(logAuditEvent).mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        userId: null,
        action: 'user_enabled_console',
        entityId: id,
        summary: 'Enabled user only-admin@localhost from the server console',
      }),
    ]);
  });

  it('says so for a user who was not disabled', async () => {
    await seedUser('fine', 'active');
    expect(await (await POST(request('fine'))).json()).toEqual({
      email: 'fine@localhost',
      wasDisabled: false,
    });
  });

  it('answers 404 for an unknown user', async () => {
    expect((await POST(request('ghost'))).status).toBe(404);
  });

  it('answers 404 and changes nothing off loopback, unsigned, mis-purposed or unstamped', async () => {
    const id = await seedUser('guarded', 'disabled');

    expect((await POST(request('guarded', { peer: '10.0.0.5' }))).status).toBe(404);
    expect((await POST(request('guarded', { secret: 'some-other-secret' }))).status).toBe(404);
    expect((await POST(request('guarded', { purpose: 'reset-2fa' }))).status).toBe(404);
    delete flags[STAMPED];
    expect((await POST(request('guarded'))).status).toBe(404);

    expect(await statusOf(id)).toBe('disabled');
    expect(vi.mocked(logAuditEvent)).not.toHaveBeenCalled();
  });
});
