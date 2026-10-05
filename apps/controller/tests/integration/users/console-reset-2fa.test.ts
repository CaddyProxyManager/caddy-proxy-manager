/**
 * `cpm-server --reset-2fa`: the console recovery for a lost authenticator also removes the user's
 * passkeys, since a stolen passkey stands in for both factors.
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
import { POST } from '@/src/app/api/internal/reset-2fa/route';
import { logAuditEvent } from '@/src/lib/audit';
import { config } from '@/src/lib/config';
import { signConsoleCommand } from '@/src/lib/users/console-command';
import { PEER_ADDRESS_HEADER } from '@/src/lib/http/peer-address';
import { passkeys, sessions, twoFactors, users } from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();
const STAMPED = Symbol.for('cpm.peer-address-stamped');
const flags = globalThis as Record<symbol, unknown>;

async function seedUser(username: string, withPasskey: boolean): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email: `${username}@localhost`,
      username,
      role: 'admin',
      status: 'active',
      twoFactorEnabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: users.id });
  await ctx.db.insert(twoFactors).values({ userId: row.id, secret: 's', backupCodes: '[]' });
  if (withPasskey) {
    await ctx.db.insert(passkeys).values({
      userId: row.id,
      publicKey: 'cose',
      credentialID: `credential-${username}`,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      createdAt: NOW,
    });
  }
  await ctx.db.insert(sessions).values({
    userId: row.id,
    token: `session-${username}`,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: NOW,
    updatedAt: NOW,
  });
  return row.id;
}

function request(username: string, peer = '127.0.0.1', secret = config.sessionSecret) {
  const timestamp = Date.now();
  return new NextRequest('http://localhost/api/internal/reset-2fa', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PEER_ADDRESS_HEADER]: peer },
    body: JSON.stringify({
      username,
      timestamp,
      signature: signConsoleCommand(secret, username, timestamp),
    }),
  });
}

const rowsFor = async (userId: number) => ({
  passkeys: await ctx.db.select().from(passkeys).where(eq(passkeys.userId, userId)),
  twoFactors: await ctx.db.select().from(twoFactors).where(eq(twoFactors.userId, userId)),
  sessions: await ctx.db.select().from(sessions).where(eq(sessions.userId, userId)),
});

beforeEach(() => {
  flags[STAMPED] = true;
  vi.mocked(logAuditEvent).mockClear();
});

afterAll(() => {
  delete flags[STAMPED];
});

describe('POST /api/internal/reset-2fa', () => {
  it('turns off 2FA, removes the passkeys, ends the sessions and audits both', async () => {
    const id = await seedUser('locked-out', true);

    const response = await POST(request('locked-out'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: 'locked-out@localhost',
      hadTwoFactor: true,
      passkeysRemoved: 1,
    });
    const left = await rowsFor(id);
    expect(left.passkeys).toHaveLength(0);
    expect(left.twoFactors).toHaveLength(0);
    expect(left.sessions).toHaveLength(0);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(user.twoFactorEnabled).toBe(false);
    const actions = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action);
    expect(actions).toEqual(['two_factor_reset', 'passkey_removed']);
  });

  it('audits no passkey removal for a user without one', async () => {
    await seedUser('no-passkey', false);

    const response = await POST(request('no-passkey'));

    expect((await response.json()).passkeysRemoved).toBe(0);
    const actions = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action);
    expect(actions).toEqual(['two_factor_reset']);
  });

  it('answers 404 and changes nothing off loopback, unsigned or unstamped', async () => {
    const id = await seedUser('guarded', true);

    expect((await POST(request('guarded', '10.0.0.5'))).status).toBe(404);
    expect((await POST(request('guarded', '127.0.0.1', 'some-other-secret'))).status).toBe(404);
    delete flags[STAMPED];
    expect((await POST(request('guarded'))).status).toBe(404);

    const left = await rowsFor(id);
    expect(left.passkeys).toHaveLength(1);
    expect(left.twoFactors).toHaveLength(1);
    expect(left.sessions).toHaveLength(1);
    expect(vi.mocked(logAuditEvent)).not.toHaveBeenCalled();
  });
});
