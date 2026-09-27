/**
 * Writes a pre-3.0 SQLite database for the migration e2e spec. A script the spec spawns with
 * `bun`, because Playwright runs specs under Node, which has no `bun:sqlite` or `Bun.password`.
 * The schema is the real 3.0 migrations in `drizzle/legacy-sqlite`, not one a test invented.
 *
 *   bun tests/helpers/build-legacy-db.ts <password>
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { LEGACY_FILE, LEGACY_FIXTURE, LEGACY_DIR } from './legacy-db';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const LEGACY_MIGRATIONS = resolve(moduleDir, '../../drizzle/legacy-sqlite');
const NOW = '2026-01-01T00:00:00.000Z';

/**
 * Read off `_`: @types/yargs types a `.command()` positional as `unknown`. `strict` would reject
 * the positional itself, and numbers stay strings so a password of `007` hashes intact.
 */
const [password] = yargs(hideBin(process.argv))
  .scriptName('build-legacy-db')
  .usage('Usage: $0 <password>')
  .parserConfiguration({ 'parse-positional-numbers': false })
  .demandCommand(1, 'the admin password to hash into the fixture is required')
  .strictOptions()
  .help()
  .parseSync()
  ._.map(String);

// A real hash: signing in is the only proof the credential row survived the import.
const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });

// The file only: the directory is a bind-mount source, and removing it orphans a running mount.
mkdirSync(LEGACY_DIR, { recursive: true });
rmSync(LEGACY_FILE, { force: true });

const raw = new Database(LEGACY_FILE);
migrate(drizzle(raw), { migrationsFolder: LEGACY_MIGRATIONS });

raw.run(
  `INSERT INTO users (id, email, name, passwordHash, role, provider, subject, username,
                      displayUsername, status, createdAt, updatedAt)
   VALUES (1, 'legacyadmin@localhost', 'Legacy Admin', ?, 'admin', 'credentials', 'legacyadmin',
           ?, ?, 'active', ?, ?)`,
  [passwordHash, LEGACY_FIXTURE.adminUsername, LEGACY_FIXTURE.adminUsername, NOW, NOW],
);

// Better Auth signs in from this row, not users.passwordHash.
raw.run(
  `INSERT INTO accounts (userId, accountId, providerId, issuer, password, createdAt, updatedAt)
   VALUES (1, '1', 'credential', 'local:credential', ?, ?, ?)`,
  [passwordHash, NOW, NOW],
);

raw.run(
  `INSERT INTO proxy_hosts (id, name, domains, upstreams, sslForced, hstsEnabled,
                            hstsSubdomains, allowWebsocket, preserveHostHeader, enabled,
                            skipHttpsHostnameValidation, createdAt, updatedAt)
   VALUES (1, ?, ?, '["10.0.0.9:8080"]', 1, 1, 0, 1, 1, 1, 0, ?, ?)`,
  [LEGACY_FIXTURE.proxyHostName, JSON.stringify([LEGACY_FIXTURE.proxyHostDomain]), NOW, NOW],
);

raw.run("INSERT INTO settings (key, value, updatedAt) VALUES ('general', ?, ?)", [
  JSON.stringify({ primaryDomain: LEGACY_FIXTURE.primaryDomain }),
  NOW,
]);

raw.close(true);
console.log(LEGACY_FILE);
