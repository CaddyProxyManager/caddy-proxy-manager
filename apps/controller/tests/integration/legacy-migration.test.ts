/**
 * Migrating a real pre-3.0 SQLite database into PostgreSQL. The fixture runs the SQLite
 * migrations every 3.0 deployment ran, so this exercises the shapes an upgrade actually meets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq, isNull } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const schemaModule = await import('@/src/lib/db/schema');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

const { importLegacyDatabase } = await import('@/src/lib/migration/import');
const { decryptSecret, encryptSecret } = await import('@/src/lib/secret');
const { carryOverBlobSettings } = await import('@/src/lib/migration/settings-carryover');
const registry = await import('@/src/lib/settings/registry');
const { getSetting, invalidateSettingsCache } = await import('@/src/lib/settings/resolve');
const { inspectLegacyDatabase, scanForLegacyDatabases } = await import(
  '@/src/lib/migration/legacy-database'
);

const LEGACY_MIGRATIONS = resolve(process.cwd(), 'drizzle', 'legacy-sqlite');
const NOW = '2026-01-01T00:00:00.000Z';

let directory: string;

/** A SQLite database with the 3.0 schema and a realistic set of rows. */
function buildLegacyDatabase(): string {
  const path = join(directory, 'caddy-proxy-manager.db');
  const raw = new Database(path);
  migrate(drizzle(raw), { migrationsFolder: LEGACY_MIGRATIONS });

  raw.run(
    `INSERT INTO users (id, email, name, passwordHash, role, provider, subject, username,
                        displayUsername, status, createdAt, updatedAt)
     VALUES (1, 'admin@localhost', 'admin', '$argon2id$hash', 'admin', 'credentials', 'admin',
             'admin', 'admin', 'active', ?, ?),
            (2, 'viewer@localhost', 'viewer', '$argon2id$hash', 'viewer', 'credentials', 'viewer',
             'viewer', 'viewer', 'active', ?, ?)`,
    [NOW, NOW, NOW, NOW],
  );

  // The credential account row Better Auth reads.
  raw.run(
    `INSERT INTO accounts (userId, accountId, providerId, issuer, password, createdAt, updatedAt)
     VALUES (1, '1', 'credential', 'local:credential', '$argon2id$hash', ?, ?)`,
    [NOW, NOW],
  );

  // An API token belongs to a user and has nowhere to record that it does not, so it is the row a
  // selection that leaves users behind has to drop rather than blank.
  raw.run(
    `INSERT INTO api_tokens (id, name, tokenHash, createdBy, createdAt)
     VALUES (1, 'ci', 'hash-of-a-token', 1, ?)`,
    [NOW],
  );

  // The access list is what makes leaving it behind unsafe: the reference from a proxy host is
  // nullable, so an import could blank it and publish a host that used to want a password.
  raw.run(
    `INSERT INTO access_lists (id, name, description, createdBy, createdAt, updatedAt)
     VALUES (1, 'staff', 'internal only', 1, ?, ?)`,
    [NOW, NOW],
  );

  // sslForced/hstsEnabled and friends are 0/1 here and boolean in PostgreSQL.
  raw.run(
    `INSERT INTO proxy_hosts (id, name, domains, upstreams, accessListId, ownerUserId, sslForced,
                              hstsEnabled, hstsSubdomains, allowWebsocket, preserveHostHeader,
                              enabled, skipHttpsHostnameValidation, createdAt, updatedAt)
     VALUES (1, 'app', '["app.example.com"]', '["10.0.0.5:8080"]', 1, 1, 1, 1, 0, 1, 1, 1, 0, ?, ?),
            (2, 'api', '["api.example.com"]', '["10.0.0.6:8080"]', NULL, NULL, 0, 0, 0, 1, 1, 0, 1,
             ?, ?)`,
    [NOW, NOW, NOW, NOW],
  );

  raw.run(
    `INSERT INTO settings (key, value, updatedAt)
     VALUES ('general', '{"primaryDomain":"example.com"}', ?),
            ('avatars', '{"gravatarEnabled":false}', ?)`,
    [NOW, NOW],
  );

  raw.close(true);
  return path;
}

beforeEach(async () => {
  invalidateSettingsCache();
  directory = mkdtempSync(join(tmpdir(), 'cpm-legacy-'));
  for (const table of [
    schemaModule.caCertificates,
    schemaModule.accounts,
    schemaModule.apiTokens,
    schemaModule.proxyHosts,
    schemaModule.accessLists,
    schemaModule.settings,
    schemaModule.users,
  ]) {
    await ctx.db.delete(table);
  }
});

afterEach(() => {
  delete process.env.LEGACY_SQLITE_PATH;
  // Every handle is closed with `close(true)`, or this fails intermittently on Windows with EBUSY.
  rmSync(directory, { recursive: true, force: true });
});

describe('inspection', () => {
  it('accepts a real database and reports what is in it', () => {
    const result = inspectLegacyDatabase(buildLegacyDatabase());
    expect('reason' in result).toBe(false);
    if ('reason' in result) return;

    expect(result.counts).toMatchObject({ users: 2, proxyHosts: 2, settings: 2 });
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('rejects a SQLite file that is not ours, and says which tables were missing', () => {
    const path = join(directory, 'unrelated.db');
    const other = new Database(path);
    other.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    other.close(true);

    const result = inspectLegacyDatabase(path);
    expect('reason' in result).toBe(true);
    if (!('reason' in result)) return;
    expect(result.reason).toMatch(/users/);
    expect(result.reason).toMatch(/not a Caddy Proxy Manager database/i);
  });

  it('rejects a file that is not a database at all', async () => {
    const path = join(directory, 'notes.db');
    await Bun.write(path, 'this is not sqlite');

    const result = inspectLegacyDatabase(path);
    expect('reason' in result).toBe(true);
  });

  it('rejects a path with nothing at it', () => {
    const result = inspectLegacyDatabase(join(directory, 'missing.db'));
    expect(result).toMatchObject({ reason: 'No file at that path.' });
  });

  it('honours LEGACY_SQLITE_PATH over searching', () => {
    process.env.LEGACY_SQLITE_PATH = buildLegacyDatabase();
    const { candidates } = scanForLegacyDatabases();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.counts.proxyHosts).toBe(2);
  });
});

describe('import', () => {
  it('copies rows across and keeps their ids', async () => {
    const report = await importLegacyDatabase(buildLegacyDatabase());
    expect(report.totalRows).toBeGreaterThan(0);

    const users = await ctx.db.select().from(schemaModule.users);
    expect(users.map((user) => user.id).sort()).toEqual([1, 2]);
    expect(users.find((user) => user.id === 1)?.role).toBe('admin');
  });

  it('gives imported users UUIDs but keeps sending their numeric forward-auth id', async () => {
    await importLegacyDatabase(buildLegacyDatabase());

    const users = await ctx.db.select().from(schemaModule.users);
    expect(users.every((user) => typeof user.uuid === 'string' && user.uuid.length === 36)).toBe(
      true,
    );
    const [pinned] = await ctx.db
      .select()
      .from(schemaModule.settings)
      .where(eq(schemaModule.settings.key, 'config:forward_auth_sequential_user_ids'));
    expect(pinned?.value).toBe('true');
  });

  it('converts SQLite 0/1 into real booleans', async () => {
    await importLegacyDatabase(buildLegacyDatabase());

    const hosts = await ctx.db.select().from(schemaModule.proxyHosts);
    const app = hosts.find((host) => host.name === 'app');
    const api = hosts.find((host) => host.name === 'api');

    expect(app?.sslForced).toBe(true);
    expect(app?.hstsSubdomains).toBe(false);
    expect(api?.sslForced).toBe(false);
    expect(api?.skipHttpsHostnameValidation).toBe(true);
  });

  it('carries the credential account across, so the migrated admin can still sign in', async () => {
    // Better Auth must read an account row written by the old release, and can only reach one
    // through this import.
    await importLegacyDatabase(buildLegacyDatabase());

    const accounts = await ctx.db
      .select()
      .from(schemaModule.accounts)
      .where(eq(schemaModule.accounts.userId, 1));

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: 'credential',
      accountId: '1',
    });
    expect(accounts[0]?.password).toBeTruthy();
  });

  it('leaves the id sequences past the copied rows', async () => {
    // Without this, the first proxy host created after an upgrade is handed id 1 and dies on the
    // primary key.
    await importLegacyDatabase(buildLegacyDatabase());

    const [created] = await ctx.db
      .insert(schemaModule.proxyHosts)
      .values({
        name: 'created-after-migrating',
        domains: '["new.example.com"]',
        upstreams: '["10.0.0.9:80"]',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();

    expect(created?.id).toBeGreaterThan(2);
  });

  it('brings the settings rows with it', async () => {
    await importLegacyDatabase(buildLegacyDatabase());

    const rows = await ctx.db.select().from(schemaModule.settings);
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    expect(byKey.get('general')).toContain('example.com');
    expect(byKey.get('avatars')).toContain('gravatarEnabled');
  });

  it('names the tables this version dropped rather than silently ignoring them', async () => {
    const path = buildLegacyDatabase();
    const raw = new Database(path);
    raw.run('CREATE TABLE dead_hosts (id INTEGER PRIMARY KEY, domain TEXT)');
    raw.run("INSERT INTO dead_hosts (id, domain) VALUES (1, 'gone.example.com')");
    raw.close(true);

    const report = await importLegacyDatabase(path);
    expect(report.droppedFromSchema).toContain('dead_hosts');
  });

  it('is safe to run twice, and says it copied nothing the second time', async () => {
    const path = buildLegacyDatabase();
    const first = await importLegacyDatabase(path);
    const second = await importLegacyDatabase(path);

    const users = await ctx.db.select().from(schemaModule.users);
    expect(users).toHaveLength(2);

    expect(first.totalRows).toBeGreaterThan(0);
    // The batch size would claim a second run had migrated everything again.
    expect(second.totalRows).toBe(0);
  });

  it('encrypts a CA private key the old release kept in plain text', async () => {
    const path = buildLegacyDatabase();
    const raw = new Database(path);
    raw.run(
      `INSERT INTO ca_certificates (id, name, certificatePem, privateKeyPem, createdBy, createdAt,
                                    updatedAt)
       VALUES (1, 'root', 'CERT', 'PLAIN CA KEY', 1, ?, ?)`,
      [NOW, NOW],
    );
    raw.close(true);

    await importLegacyDatabase(path);
    const [ca] = await ctx.db.select().from(schemaModule.caCertificates);
    expect(ca.privateKeyPem?.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(ca.privateKeyPem!)).toBe('PLAIN CA KEY');
    expect(ca.certificatePem).toBe('CERT');
  });

  it('inserts users before the accounts that reference them', async () => {
    // Ordering is derived from the schema's foreign keys; if that sort regressed, the accounts
    // insert would fail outright rather than producing an orphan.
    await importLegacyDatabase(buildLegacyDatabase());

    const { accounts, users } = schemaModule;
    const orphans = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .leftJoin(users, eq(users.id, accounts.userId))
      .where(isNull(users.id));
    expect(orphans).toHaveLength(0);
  });
});

describe('choosing what to migrate', () => {
  it('leaves the old accounts behind but brings the hosts', async () => {
    // The case this exists for: an installation changing hands wants the configuration and none
    // of the people who used to sign in to it.
    await importLegacyDatabase(buildLegacyDatabase(), ['proxyHosts', 'settings']);

    expect(await ctx.db.select().from(schemaModule.users)).toHaveLength(0);
    expect(await ctx.db.select().from(schemaModule.proxyHosts)).toHaveLength(2);
  });

  it('drops the rows that cannot exist without the user they belong to', async () => {
    // api_tokens.createdBy is not nullable. Blanking it is not an option, so the table goes with
    // the users - and that is derived from the foreign key, not from a list.
    const report = await importLegacyDatabase(buildLegacyDatabase(), ['proxyHosts', 'settings']);

    expect(await ctx.db.select().from(schemaModule.apiTokens)).toHaveLength(0);
    expect(report.excludedBySelection).toContain('api_tokens');
    expect(report.excludedBySelection).toContain('users');
  });

  it('empties the ownership a migrated host had rather than failing on it', async () => {
    // ownerUserId is provenance - nothing authorises against it - so a host that loses it is
    // still the host it was, and refusing the import over it would help nobody.
    const report = await importLegacyDatabase(buildLegacyDatabase(), ['proxyHosts']);

    const hosts = await ctx.db.select().from(schemaModule.proxyHosts);
    expect(hosts.every((host) => host.ownerUserId === null)).toBe(true);
    expect(report.clearedReferences).toContain('proxy_hosts.ownerUserId');
  });

  it('brings the access list along with the host it was protecting', async () => {
    // Only proxyHosts was asked for. If access lists were left behind, accessListId would be
    // blanked and app.example.com would come back publicly reachable.
    await importLegacyDatabase(buildLegacyDatabase(), ['proxyHosts']);

    expect(await ctx.db.select().from(schemaModule.accessLists)).toHaveLength(1);
    const [app] = await ctx.db
      .select()
      .from(schemaModule.proxyHosts)
      .where(eq(schemaModule.proxyHosts.name, 'app'));
    expect(app?.accessListId).toBe(1);
  });

  it('leaves the settings behind when they were not chosen', async () => {
    await importLegacyDatabase(buildLegacyDatabase(), ['users']);

    // The one row left is not copied: importing users pins their numeric forward-auth id.
    const rows = await ctx.db.select().from(schemaModule.settings);
    expect(rows.map((row) => row.key)).toEqual(['config:forward_auth_sequential_user_ids']);
    expect(await ctx.db.select().from(schemaModule.users)).toHaveLength(2);
  });

  it('copies everything when no selection is given', async () => {
    const report = await importLegacyDatabase(buildLegacyDatabase());

    expect(report.excludedBySelection).toEqual([]);
    expect(report.clearedReferences).toEqual([]);
    expect(await ctx.db.select().from(schemaModule.apiTokens)).toHaveLength(1);
  });
});

describe('carrying the old JSON settings into the registry', () => {
  it('lifts the gravatar toggle out of its blob, so an upgrade does not reset it', async () => {
    // The fixture has avatars.gravatarEnabled = false.
    await importLegacyDatabase(buildLegacyDatabase());
    invalidateSettingsCache();

    const applied = await carryOverBlobSettings();
    expect(applied).toContainEqual({ settingKey: registry.gravatarEnabled.key, value: false });

    invalidateSettingsCache();
    expect(await getSetting(registry.gravatarEnabled)).toBe(false);
  });

  it('writes nothing for a deployment that never touched the toggle', async () => {
    // No blob at all: storing a value here would pin a default that was free to change.
    const applied = await carryOverBlobSettings();
    expect(applied).toEqual([]);
  });

  it('ignores a blob it cannot parse rather than failing the migration', async () => {
    await ctx.db.insert(schemaModule.settings).values({
      key: 'avatars',
      value: 'not json at all',
      updatedAt: NOW,
    });

    const applied = await carryOverBlobSettings();
    expect(applied).toEqual([]);
  });

  it('ignores a field of the wrong type', async () => {
    await ctx.db.insert(schemaModule.settings).values({
      key: 'avatars',
      value: JSON.stringify({ gravatarEnabled: 'yes please' }),
      updatedAt: NOW,
    });

    const applied = await carryOverBlobSettings();
    expect(applied).toEqual([]);
  });
});

/**
 * A database whose secrets were encrypted under a SESSION_SECRET this deployment does not have.
 * The old value is asked for once and used to re-encrypt under this deployment's key.
 */
describe('a database encrypted with a different SESSION_SECRET', () => {
  const OLD_SECRET = 'the-old-installations-session-secret-4321';

  /** The on-disk envelope, written by hand: nothing in production can encrypt under another key. */
  function encryptWithOldSecret(value: string): string {
    const key = Buffer.from(
      hkdfSync('sha256', OLD_SECRET, Buffer.alloc(0), 'caddy-proxy-manager:secret:v1', 32),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'enc:v1:',
      iv.toString('base64'),
      ':',
      cipher.getAuthTag().toString('base64'),
      ':',
      ciphertext.toString('base64'),
    ].join('');
  }

  /** The fixture, plus a certificate whose private key only the old secret opens. */
  function withOldSecrets(): string {
    const path = buildLegacyDatabase();
    const raw = new Database(path);
    raw.run(
      `INSERT INTO certificates (id, name, type, domainNames, autoRenew, privateKeyPem,
                                 createdAt, updatedAt)
       VALUES (1, 'wildcard', 'custom', '["*.example.com"]', 0, ?, ?, ?)`,
      [encryptWithOldSecret('-----BEGIN PRIVATE KEY-----'), NOW, NOW],
    );
    raw.close(true);
    return path;
  }

  it('re-encrypts the old secrets under this deployment key', async () => {
    await importLegacyDatabase(withOldSecrets(), undefined, { legacyKey: OLD_SECRET });

    const [row] = await ctx.db
      .select({ privateKeyPem: schemaModule.certificates.privateKeyPem })
      .from(schemaModule.certificates)
      .where(eq(schemaModule.certificates.id, 1));

    expect(decryptSecret(row.privateKeyPem as string)).toBe('-----BEGIN PRIVATE KEY-----');
    // Re-encrypted rather than copied: the old secret is not needed again after this.
    expect(row.privateKeyPem).not.toBe(encryptWithOldSecret('-----BEGIN PRIVATE KEY-----'));
  });

  it('refuses without the key, and writes nothing at all', async () => {
    await expect(importLegacyDatabase(withOldSecrets())).rejects.toThrow(
      /different SESSION_SECRET/,
    );

    // The refusal has to be total. A partial import is the one state the operator is told not to
    // retry against, so a missing key must not leave the users behind that the certificates follow.
    const users = await ctx.db.select().from(schemaModule.users);
    expect(users).toEqual([]);
  });

  it('refuses a wrong key, and writes nothing at all', async () => {
    await expect(
      importLegacyDatabase(withOldSecrets(), undefined, { legacyKey: 'not-the-old-secret' }),
    ).rejects.toThrow(/does not decrypt/);

    const users = await ctx.db.select().from(schemaModule.users);
    expect(users).toEqual([]);
  });

  it('names the table the unreadable value was in', async () => {
    await expect(importLegacyDatabase(withOldSecrets())).rejects.toThrow(/certificates/);
  });

  it('needs no key when the secret has not changed', async () => {
    const path = buildLegacyDatabase();
    const raw = new Database(path);
    raw.run(
      `INSERT INTO certificates (id, name, type, domainNames, autoRenew, privateKeyPem,
                                 createdAt, updatedAt)
       VALUES (1, 'wildcard', 'custom', '["*.example.com"]', 0, ?, ?, ?)`,
      [encryptSecret('-----BEGIN PRIVATE KEY-----'), NOW, NOW],
    );
    raw.close(true);

    // The ordinary upgrade: same secret carried over, so the flow never asks for anything.
    const report = await importLegacyDatabase(path);
    expect(report.totalRows).toBeGreaterThan(0);
  });
});
