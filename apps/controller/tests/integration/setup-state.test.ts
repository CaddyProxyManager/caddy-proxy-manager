/**
 * The first-run setup state machine. The stage is derived from what exists, so the cases pinned
 * are the ambiguous ones: halfway through, an upgrade from before setup, a restart in either.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { vi } from '@/tests/helpers/vi';
import { createTestDb, currentDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const schemaModule = await import('@/src/lib/db/schema');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => ({
  default: currentDb(() => ctx.db),
  db: currentDb(() => ctx.db),
  client: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));

const {
  backfillSetupCompletion,
  declineMigration,
  getSetupState,
  hasAnySignIn,
  isSetupCompleted,
  markSetupCompleted,
  promoteFirstSetupAdmin,
  recordMigrationSource,
} = await import('@/src/lib/setup');

const TOUCHED_ENV = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'OAUTH_ENABLED', 'LEGACY_SQLITE_PATH'];

async function addUser(email: string) {
  const now = new Date().toISOString();
  await ctx.db.insert(schemaModule.users).values({
    email,
    name: email,
    passwordHash: 'x',
    role: 'admin',
    provider: 'credentials',
    subject: email,
    username: email,
    displayUsername: email,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  await ctx.db.delete(schemaModule.settings);
  await ctx.db.delete(schemaModule.accounts);
  await ctx.db.delete(schemaModule.users);
  await ctx.db.delete(schemaModule.oauthProviders);
});

describe('stage', () => {
  it('asks for an account when nothing can sign in', async () => {
    expect(await getSetupState(false)).toEqual({ stage: 'account', required: true });
  });

  it('asks for a sign-in once an account exists', async () => {
    await addUser('admin@localhost');
    expect(await getSetupState(false)).toEqual({ stage: 'verify', required: true });
  });

  it('moves to the settings step once the sign-in is proven', async () => {
    await addUser('admin@localhost');
    expect(await getSetupState(true)).toEqual({ stage: 'settings', required: true });
  });

  it('is finished once the flag is set, whoever is signed in', async () => {
    await addUser('admin@localhost');
    await markSetupCompleted();

    expect(await getSetupState(false)).toEqual({ stage: 'complete', required: false });
    expect(await getSetupState(true)).toEqual({ stage: 'complete', required: false });
  });

  it('does not go back to account creation after the settings step', async () => {
    // The operator created an account and is on the settings step. Nothing about a page reload,
    // a new tab, or a signed-out session may send them back to creating a second account.
    await addUser('admin@localhost');
    expect((await getSetupState(true)).stage).toBe('settings');
    expect((await getSetupState(false)).stage).not.toBe('account');
  });
});

describe('what counts as a way in', () => {
  it('counts a local account', async () => {
    expect(await hasAnySignIn()).toBe(false);
    await addUser('admin@localhost');
    expect(await hasAnySignIn()).toBe(true);
  });

  it('counts an enabled OAuth provider with no local accounts at all', async () => {
    const now = new Date().toISOString();
    await ctx.db.insert(schemaModule.oauthProviders).values({
      id: 'idp',
      name: 'IdP',
      type: 'oidc',
      clientId: 'id',
      clientSecret: 'secret',
      issuer: 'https://idp.example',
      scopes: 'openid email profile',
      autoLink: false,
      enabled: true,
      source: 'ui',
      createdAt: now,
      updatedAt: now,
    });

    expect(await hasAnySignIn()).toBe(true);
    expect((await getSetupState(false)).stage).toBe('verify');
  });

  it('does not count a disabled provider', async () => {
    const now = new Date().toISOString();
    await ctx.db.insert(schemaModule.oauthProviders).values({
      id: 'off',
      name: 'Disabled',
      type: 'oidc',
      clientId: 'id',
      clientSecret: 'secret',
      issuer: 'https://idp.example',
      scopes: 'openid email profile',
      autoLink: false,
      enabled: false,
      source: 'ui',
      createdAt: now,
      updatedAt: now,
    });

    expect(await hasAnySignIn()).toBe(false);
    expect((await getSetupState(false)).stage).toBe('account');
  });
});

describe('backfill for installations that predate setup', () => {
  it('marks an environment-configured installation complete', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'Strong-Admin-Passw0rd!';
    await addUser('admin@localhost');

    await backfillSetupCompletion();
    expect(await isSetupCompleted()).toBe(true);
  });

  it('leaves an operator midway through setup alone', async () => {
    // The account came from the setup form, so the environment names no credentials. Marking this
    // complete on the next restart would drop them into an unconfigured app with no way back.
    await addUser('someone@localhost');

    await backfillSetupCompletion();
    expect(await isSetupCompleted()).toBe(false);
    expect((await getSetupState(true)).stage).toBe('settings');
  });

  it('does nothing when the environment configures a sign-in but the database is empty', async () => {
    // The admin seed has not run yet. Marking setup complete here would skip the flow for a
    // deployment that has no account at all.
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'Strong-Admin-Passw0rd!';

    await backfillSetupCompletion();
    expect(await isSetupCompleted()).toBe(false);
  });

  it('recognises an OIDC-only installation by its environment provider', async () => {
    process.env.OAUTH_ENABLED = 'true';
    await addUser('federated@localhost');

    await backfillSetupCompletion();
    expect(await isSetupCompleted()).toBe(true);
  });

  it('is idempotent', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'Strong-Admin-Passw0rd!';
    await addUser('admin@localhost');

    await backfillSetupCompletion();
    await backfillSetupCompletion();
    expect(await isSetupCompleted()).toBe(true);
  });
});

describe('the migration offer', () => {
  // LEGACY_SQLITE_PATH pins the scan to one file, so these do not depend on what happens to be
  // lying around the working directory.
  function pointAtLegacyDatabase(): string {
    const directory = mkdtempSync(join(tmpdir(), 'cpm-setup-legacy-'));
    const path = join(directory, 'old.db');
    const raw = new Database(path);
    migrate(drizzle(raw), { migrationsFolder: resolve(process.cwd(), 'drizzle', 'legacy-sqlite') });
    raw.close(true);
    process.env.LEGACY_SQLITE_PATH = path;
    return directory;
  }

  /**
   * bun:sqlite's plain `close()` releases the file only once its statements are finalized, which
   * happens on collection - and Windows refuses the removal until then. `close(true)` above
   * finalizes them there and then, so this can just delete the directory.
   */
  function discard(directory: string): void {
    rmSync(directory, { recursive: true, force: true });
  }

  it('offers migration before account creation when an old database is present', async () => {
    const directory = pointAtLegacyDatabase();
    try {
      expect((await getSetupState(false)).stage).toBe('migrate');
    } finally {
      discard(directory);
    }
  });

  it('falls through to account creation once the offer is declined', async () => {
    const directory = pointAtLegacyDatabase();
    try {
      await declineMigration();
      expect((await getSetupState(false)).stage).toBe('account');
    } finally {
      discard(directory);
    }
  });

  it('does not offer migration once the old database has been imported', async () => {
    // Users exist after an import, which moves the flow to proving the sign-in works. Offering
    // migration again here would invite a second import on top of the first.
    const directory = pointAtLegacyDatabase();
    try {
      await addUser('migrated@localhost');
      expect((await getSetupState(false)).stage).toBe('verify');
    } finally {
      discard(directory);
    }
  });

  it('sends a migration that left the accounts behind on to account creation', async () => {
    // The old database is still there and nothing can sign in yet. Recording the source separates
    // "not dealt with" from "dealt with, and it brought no users".
    const directory = pointAtLegacyDatabase();
    try {
      await recordMigrationSource(process.env.LEGACY_SQLITE_PATH ?? '');
      expect((await getSetupState(false)).stage).toBe('account');
    } finally {
      discard(directory);
    }
  });

  it('goes straight to account creation when there is nothing to migrate', async () => {
    process.env.LEGACY_SQLITE_PATH = join(tmpdir(), 'definitely-not-here.db');
    expect((await getSetupState(false)).stage).toBe('account');
  });
});

/**
 * The OAuth account step stores only a provider; Better Auth's callback pins the user it creates
 * to `role: "user"`, and only an admin can finish setup. `saveSetupSettings` promotes them as
 * it saves.
 */
describe('promoteFirstSetupAdmin', () => {
  async function addUserWithAccount(
    email: string,
    providerId: string,
    role: string,
    status: string,
  ) {
    const now = new Date().toISOString();
    const [row] = await ctx.db
      .insert(schemaModule.users)
      .values({
        email,
        name: email,
        role,
        provider: providerId === 'credential' ? 'credentials' : 'oidc',
        subject: email,
        status,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await ctx.db.insert(schemaModule.accounts).values({
      userId: row.id,
      accountId: email,
      providerId,
      createdAt: now,
      updatedAt: now,
    });
    return row.id;
  }

  const addFederatedUser = (email: string, role = 'user', status = 'active') =>
    addUserWithAccount(email, 'authentik', role, status);

  async function roleOf(userId: number): Promise<string> {
    const rows = await ctx.db
      .select()
      .from(schemaModule.users)
      .where(eq(schemaModule.users.id, userId));
    return rows[0].role;
  }

  it('promotes a federated user when setup is unfinished and nobody is an admin', async () => {
    const userId = await addFederatedUser('sso@example.com');

    expect(await promoteFirstSetupAdmin(userId)).toBe(true);
    expect(await roleOf(userId)).toBe('admin');
  });

  it('refuses a second caller once the first was promoted', async () => {
    const first = await addFederatedUser('sso@example.com');
    await promoteFirstSetupAdmin(first);

    const second = await addFederatedUser('colleague@example.com');
    expect(await promoteFirstSetupAdmin(second)).toBe(false);
    expect(await roleOf(second)).toBe('user');
  });

  it('does nothing once setup is complete', async () => {
    await markSetupCompleted();
    const userId = await addFederatedUser('late@example.com');

    expect(await promoteFirstSetupAdmin(userId)).toBe(false);
    expect(await roleOf(userId)).toBe('user');
  });

  it('does nothing when the local account step already made an admin', async () => {
    await addUser('admin@localhost');
    const userId = await addFederatedUser('sso@example.com');

    expect(await promoteFirstSetupAdmin(userId)).toBe(false);
    expect(await roleOf(userId)).toBe('user');
  });

  it('never promotes a self-registered local account', async () => {
    const userId = await addUserWithAccount('signup@example.com', 'credential', 'user', 'active');

    expect(await promoteFirstSetupAdmin(userId)).toBe(false);
    expect(await roleOf(userId)).toBe('user');
  });

  it('ignores a suspended admin, which is nobody who can finish setup', async () => {
    await addFederatedUser('locked-out@example.com', 'admin', 'suspended');
    const userId = await addFederatedUser('sso@example.com');

    expect(await promoteFirstSetupAdmin(userId)).toBe(true);
    expect(await roleOf(userId)).toBe('admin');
  });
});
