/**
 * Several Better Auth endpoints bypass the app: its change-password skips `users.passwordHash` and
 * the policy, and the username probe enumerates accounts. A real instance proves the disabled
 * paths match how it normalizes them.
 */
import { describe, expect, it } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { twoFactor, username } from 'better-auth/plugins';
import { DISABLED_AUTH_PATHS } from '@/src/lib/auth-disabled-paths';

const ORIGIN = 'http://localhost:3000';

const auth = betterAuth({
  database: memoryAdapter({}),
  secret: 'test-secret-long-enough-for-better-auth-0123456789abcdef',
  baseURL: ORIGIN,
  basePath: '/api/auth',
  emailAndPassword: { enabled: true },
  disabledPaths: DISABLED_AUTH_PATHS,
  plugins: [username(), twoFactor()],
});

function call(path: string, method: 'GET' | 'POST' = 'POST') {
  return auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body:
        method === 'POST'
          ? JSON.stringify({ username: 'admin', currentPassword: 'a', newPassword: 'b' })
          : undefined,
    }),
  );
}

describe('Better Auth endpoints the app replaces', () => {
  it('answers 404 for each of them', async () => {
    for (const path of DISABLED_AUTH_PATHS) {
      expect((await call(path)).status, path).toBe(404);
    }
  });

  it('covers the password, profile, unlink and enumeration endpoints', () => {
    for (const path of [
      '/change-password',
      '/update-user',
      '/change-email',
      '/delete-user',
      '/unlink-account',
      '/is-username-available',
    ]) {
      expect(DISABLED_AUTH_PATHS).toContain(path);
    }
  });

  it('leaves the TOTP and backup-code checks reachable', async () => {
    // No 2FA cookie, so refused - but by the plugin, not as a missing route.
    for (const path of ['/two-factor/verify-totp', '/two-factor/verify-backup-code']) {
      expect((await call(path)).status, path).not.toBe(404);
    }
  });

  it('still serves an endpoint left enabled', async () => {
    // Guards the first case: an instance answering 404 to everything would pass it too.
    expect((await call('/ok', 'GET')).status).toBe(200);
  });
});
