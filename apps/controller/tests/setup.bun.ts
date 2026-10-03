import { afterEach, beforeEach } from 'bun:test';
import { installFakeCaddy } from './helpers/caddy-admin';
import { cleanupTestDbs, markTestBoundary } from './helpers/db';
import { clearDotEnv } from './helpers/env';
import { vi } from './helpers/vi';

// Preloaded (bunfig.toml) once per test file, before it is imported; `--isolate` keeps it per file.

// Before any import, so no module reads the repository's .env; see tests/helpers/env.ts.
clearDotEnv();

// spyOn still works; TEST_LOG=1 restores the output.
if (!process.env.TEST_LOG) {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[method] = () => {};
  }
}

/**
 * Only the admin-API transport is faked, so every builder stays real. Reinstalled per test, so a
 * test inspecting what was sent installs its own in beforeEach or the body, not beforeAll.
 */
installFakeCaddy();
beforeEach(() => {
  installFakeCaddy();
  // Runs before the file's own hooks, so a database made in its beforeEach belongs to the test.
  markTestBoundary();
});

// Otherwise each test leaks a connection and the suite exhausts max_connections.
afterEach(async () => {
  await cleanupTestDbs();
});

/**
 * Only `auth` is replaced: Bun links eagerly, so a missing name is a SyntaxError at import, and the
 * real same-origin and role guards stay under test.
 */
// Loading auth loads the app's own db module. Left unmigrated, a query that misses a test's db
// mock fails loudly instead of landing in a database the whole run shares.
(globalThis as { __MIGRATIONS_RAN__?: boolean }).__MIGRATIONS_RAN__ = true;
const actualAuth = await import('@/src/lib/auth');

vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  auth: vi.fn().mockResolvedValue({
    user: { id: 1, email: 'test@example.com', name: 'Test User', role: 'admin' },
  }),
}));

vi.mock('@/src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));
