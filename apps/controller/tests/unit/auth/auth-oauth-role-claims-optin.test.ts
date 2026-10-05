/**
 * AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true opts out of the H3 enforcement: with a trusted IdP, the
 * user.create.before hook leaves role/status intact. The default-secure path is tested separately.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { reloadConfig } from '@/tests/helpers/config';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => {
  process.env.AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS = 'true';
  return { db: null as unknown as TestDb };
});

afterAll(async () => {
  delete process.env.AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS;
});

const { createTestDb } = await import('../../helpers/db');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

// config snapshots process.env on first evaluation, which has already happened, so it is re-read
// now and the plain specifier points at the result for auth-server.
await reloadConfig();

import { getAuth } from '../../../src/lib/auth/server';

describe('OAuth role-from-claims opt-in (AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true)', () => {
  it('leaves IdP-provided role/status intact instead of forcing defaults', async () => {
    const auth = (await getAuth()) as any;
    const hook = auth.options.databaseHooks.user.create.before;

    const result = await hook({
      email: 'trusted@idp.example',
      name: 'Trusted',
      role: 'admin',
      status: 'active',
    });

    expect(result.data.role).toBe('admin'); // claim honored - not forced to "user"
    expect(result.data.status).toBe('active');
  });
});
