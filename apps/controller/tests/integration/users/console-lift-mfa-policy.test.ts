/** `cpm-server --lift-mfa-policy`: the break glass when the two-factor policy locks everyone out. */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { NextRequest } from 'next/server';
import { POST } from '@/src/app/api/internal/lift-mfa-policy/route';
import { logAuditEvent } from '@/src/lib/audit';
import { config } from '@/src/lib/config';
import {
  CONSOLE_POLICY_SUBJECT,
  type ConsoleCommandPurpose,
  signConsoleCommand,
} from '@/src/lib/users/console-command';
import { PEER_ADDRESS_HEADER } from '@/src/lib/http/peer-address';
import { getTwoFactorPolicySettings, saveTwoFactorPolicySettings } from '@/src/lib/settings';
import { settings } from '../../../src/lib/db/schema';

const STAMPED = Symbol.for('cpm.peer-address-stamped');
const flags = globalThis as Record<symbol, unknown>;

function request(
  options: { peer?: string; purpose?: ConsoleCommandPurpose; subject?: string } = {},
) {
  const timestamp = Date.now();
  const subject = options.subject ?? CONSOLE_POLICY_SUBJECT;
  return new NextRequest('http://localhost/api/internal/lift-mfa-policy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PEER_ADDRESS_HEADER]: options.peer ?? '127.0.0.1',
    },
    body: JSON.stringify({
      username: subject,
      timestamp,
      signature: signConsoleCommand(
        config.sessionSecret,
        subject,
        timestamp,
        options.purpose ?? 'lift-mfa-policy',
      ),
    }),
  });
}

beforeEach(async () => {
  flags[STAMPED] = true;
  await ctx.db.delete(settings);
  await saveTwoFactorPolicySettings({ mode: 'all', graceDays: 0 });
  vi.mocked(logAuditEvent).mockClear();
});

afterAll(() => {
  delete flags[STAMPED];
});

describe('lifting the two-factor policy from the console', () => {
  it('turns the policy off and audits it', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ previousMode: 'all' });
    expect((await getTwoFactorPolicySettings()).mode).toBe('off');
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mfa_policy_lifted', userId: null }),
    );
  });

  it("refuses another command's signature, another subject, and anyone off the loopback", async () => {
    for (const refused of [
      request({ purpose: 'reset-2fa' }),
      request({ subject: 'admin' }),
      request({ peer: '203.0.113.9' }),
    ]) {
      expect((await POST(refused)).status).toBe(404);
    }
    expect((await getTwoFactorPolicySettings()).mode).toBe('all');
  });
});
