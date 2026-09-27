/**
 * The migration spec's pre-3.0 database. Node-safe: Playwright runs specs under Node, so the
 * `bun:sqlite` half lives in ./build-legacy-db.ts and is spawned, not imported.
 */

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Bind-mounted into web-migrate at /legacy; see tests/docker-compose.test.yml. */
export const LEGACY_DIR = resolve(moduleDir, '../.legacy');
export const LEGACY_FILE = resolve(LEGACY_DIR, 'caddy-proxy-manager.db');

/** As the container sees it, which the migration screen displays. */
export const LEGACY_CONTAINER_PATH = '/legacy/caddy-proxy-manager.db';

export const LEGACY_FIXTURE = {
  adminUsername: 'legacyadmin',
  proxyHostName: 'legacy-app',
  proxyHostDomain: 'legacy-app.example.com',
  primaryDomain: 'legacy.example.com',
} as const;

/** A missing Bun is a broken environment, not a case to degrade around. */
export function buildLegacyDatabase(password: string): void {
  execFileSync('bun', [resolve(moduleDir, 'build-legacy-db.ts'), password], {
    cwd: resolve(moduleDir, '../..'),
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/** So a re-run starts from a state the container has not already migrated. */
export function removeLegacyDatabase(): void {
  try {
    rmSync(LEGACY_FILE, { force: true });
  } catch {
    /* a leftover file is not worth failing teardown over */
  }
}
