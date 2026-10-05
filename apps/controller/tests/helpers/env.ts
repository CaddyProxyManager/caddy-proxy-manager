import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/controller - the dotenv files Bun reads sit at the repo root, two levels further up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Applied by clearDotEnv(), which the preload calls before any test file is imported. */
export const TEST_ENV: Record<string, string> = {
  // Read at module load by src/lib/db/connection.ts, so it cannot wait for a beforeEach.
  // scripts/with-test-db.ts provides the server; TEST_DB=sqlite needs none.
  DATABASE_URL:
    process.env.TEST_DB === 'sqlite' ? ':memory:' : (process.env.TEST_POSTGRES_URL ?? ''),
  // No deployment history, so the one-time data migrations in src/lib/db/index.ts skip.
  CPM_EPHEMERAL_DB: 'true',
  // src/lib/caddy/admin.ts refuses a real socket when set; `bun test` has no marker of its own.
  CPM_TEST: '1',
  SESSION_SECRET: 'test-session-secret-for-unit-tests-12345',
  NODE_ENV: 'test',
};

/** The dotenv files Bun reads on startup, in the order it applies them. */
const DOTENV_FILES = ['.env', '.env.local', '.env.test', '.env.test.local'];

/** Names only, which is all clearing needs. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Bun auto-loads .env, so a developer's local values would change the defaults under test.
 * `--env-file` cannot prevent it: `bun run test` already loaded them.
 */
export function clearDotEnv(): void {
  for (const file of DOTENV_FILES) {
    let contents: string;
    try {
      contents = readFileSync(resolve(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of contents.split('\n')) {
      const name = ASSIGNMENT.exec(line)?.[1];
      if (name) delete process.env[name];
    }
  }
  Object.assign(process.env, TEST_ENV);
}
