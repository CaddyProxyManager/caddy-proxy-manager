/**
 * Production validation refuses the example secrets shipped in .env.example and the README, and
 * outside a Next bundle, where NODE_ENV is not inlined, any non-development runtime is production.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { fresh } from '@/tests/helpers/fresh';

const STRONG_SECRET = 'q7Jm2vX9pL4rT8wZ1nB6cH3kF5sD0gA2yE7uR4tW';

async function loadConfig(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries({
    NEXT_PHASE: 'phase-production-server',
    AUTH_DISABLE_LOCAL_USERS: undefined,
    DEMO_MODE: undefined,
    ...env,
  })) {
    vi.stubEnv(key, value);
  }
  return (await import(`../../src/lib/config${fresh()}`)).config;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('production secret validation', () => {
  it('rejects the .env.example session secret placeholder', async () => {
    const config = await loadConfig({
      NODE_ENV: 'production',
      NEXT_RUNTIME: 'nodejs',
      SESSION_SECRET: 'your-secure-session-secret-here-min-32-chars',
    });
    expect(() => config.sessionSecret).toThrow(/placeholder/);
  });

  for (const password of [
    'Your-Secure-P@ssw0rd-Here!',
    'YourStr0ng-P@ssw0rd123!',
    'YourStr0ng-P@ssw0rd!',
    'Your-Str0ng-P@ssw0rd!',
  ]) {
    it(`rejects the documented example admin password ${password}`, async () => {
      const config = await loadConfig({
        NODE_ENV: 'production',
        NEXT_RUNTIME: 'nodejs',
        SESSION_SECRET: STRONG_SECRET,
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: password,
      });
      expect(() => config.adminPassword).toThrow(/example value/);
    });
  }

  it('applies production checks to an unrecognized NODE_ENV', async () => {
    const config = await loadConfig({
      NODE_ENV: 'staging',
      NEXT_RUNTIME: 'nodejs',
      SESSION_SECRET: STRONG_SECRET,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin',
    });
    expect(() => config.adminPassword).toThrow(/ADMIN_PASSWORD/);
  });

  it('applies the session secret checks to an unrecognized NODE_ENV', async () => {
    const config = await loadConfig({
      NODE_ENV: 'staging',
      NEXT_RUNTIME: 'nodejs',
      SESSION_SECRET: 'too-short',
    });
    expect(() => config.sessionSecret).toThrow(/at least 32 characters/);
  });

  it('leaves development alone', async () => {
    const config = await loadConfig({
      NODE_ENV: 'development',
      NEXT_RUNTIME: 'nodejs',
      SESSION_SECRET: 'your-secure-session-secret-here-min-32-chars',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'Your-Secure-P@ssw0rd-Here!',
    });
    expect(config.sessionSecret).toBe('your-secure-session-secret-here-min-32-chars');
    expect(config.adminPassword).toBe('Your-Secure-P@ssw0rd-Here!');
  });

  it('accepts real credentials in production', async () => {
    const config = await loadConfig({
      NODE_ENV: 'production',
      NEXT_RUNTIME: 'nodejs',
      SESSION_SECRET: STRONG_SECRET,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'Operator-Chosen-2026!',
    });
    expect(config.adminPassword).toBe('Operator-Chosen-2026!');
    expect(config.sessionSecret).toBe(STRONG_SECRET);
  });

  it('accepts the credentials the end-to-end stack runs with', async () => {
    const config = await loadConfig({
      NODE_ENV: 'production',
      NEXT_RUNTIME: 'nodejs',
      SESSION_SECRET: 'test-session-secret-32chars!xxxY',
      ADMIN_USERNAME: 'testadmin',
      ADMIN_PASSWORD: 'TestPassword2026!',
    });
    expect(config.sessionSecret).toBe('test-session-secret-32chars!xxxY');
    expect(config.adminPassword).toBe('TestPassword2026!');
  });
});
