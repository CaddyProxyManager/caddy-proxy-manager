/**
 * AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true opts out of the H3 enforcement: with a trusted IdP, the
 * user.create.before hook leaves role/status intact. The default-secure path is tested separately.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { fresh } from '@/tests/helpers/fresh';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => {
  process.env.AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS = 'true';
  return { db: null as unknown as TestDb };
});

afterAll(async () => {
  delete process.env.AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS;
});

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    get sqlite() {
      return undefined;
    },
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (v: string | Date | null | undefined): string | null =>
      !v ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString(),
  };
});

vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

// config snapshots process.env on first evaluation, which has already happened, so a fresh copy
// is evaluated now and the plain specifier points at it for auth-server.
const freshConfig = await import(`../../src/lib/config${fresh()}`);
vi.mock('../../src/lib/config', () => ({ ...freshConfig }));

import { getAuth } from '../../src/lib/auth-server';

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
