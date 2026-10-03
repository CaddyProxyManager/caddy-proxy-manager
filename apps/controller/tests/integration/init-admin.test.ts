/**
 * ensureAdminUser applies ADMIN_USERNAME/ADMIN_PASSWORD when the admin is created or when those
 * values change - not on every start, which reverted a password changed in the UI - and refuses
 * a username or @localhost email another account already signs in with.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  env: { adminUsername: 'admin', adminPassword: 'Env-Password-2026!' } as Record<string, string>,
}));

const { createTestDb } = await import('../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

// config caches the environment for the process; a restart with new values is a new process.
const actualConfig = await import('../../src/lib/config');
vi.mock('../../src/lib/config', () => ({
  ...actualConfig,
  config: new Proxy(actualConfig.config, {
    get: (target, key) =>
      typeof key === 'string' && key in ctx.env ? ctx.env[key] : Reflect.get(target, key),
  }),
}));

import { eq } from 'drizzle-orm';
import { ensureAdminUser } from '../../src/lib/init-db';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import {
  accounts,
  forwardAuthSessions,
  proxyHosts,
  sessions,
  settings,
  users,
} from '../../src/lib/db/schema';

const MARKER_KEY = 'admin_env_credentials_fingerprint';

async function adminRow() {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, 1));
  return row;
}

async function adminHash(): Promise<string> {
  return (await adminRow()).passwordHash!;
}

async function accountHash(): Promise<string> {
  const [row] = await ctx.db.select().from(accounts).where(eq(accounts.userId, 1));
  return row.password!;
}

/** As a UI change does it: the user row and the credential account. */
async function setAdminPassword(password: string) {
  const hash = await hashPassword(password);
  await ctx.db.update(users).set({ passwordHash: hash }).where(eq(users.id, 1));
  await ctx.db.update(accounts).set({ password: hash }).where(eq(accounts.userId, 1));
  return hash;
}

/** A database written before the marker existed. */
async function forgetMarker() {
  await ctx.db.delete(settings).where(eq(settings.key, MARKER_KEY));
}

async function storedMarker(): Promise<unknown> {
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, MARKER_KEY));
  return row ? JSON.parse(row.value) : null;
}

let seq = 0;

async function signIn(userId: number) {
  seq += 1;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  await ctx.db.insert(sessions).values({
    userId,
    token: `token-${userId}-${seq}`,
    expiresAt: expires,
    createdAt: now,
    updatedAt: now,
  });
  const [host] = await ctx.db
    .insert(proxyHosts)
    .values({
      name: `app-${seq}`,
      domains: JSON.stringify([`app-${seq}.example.com`]),
      upstreams: JSON.stringify(['backend:8080']),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await ctx.db.insert(forwardAuthSessions).values({
    userId,
    proxyHostId: host.id,
    audienceOrigin: `https://app-${seq}.example.com`,
    tokenHash: `hash-${userId}-${seq}`,
    expiresAt: expires,
    createdAt: now,
  });
}

async function sessionCounts(userId: number) {
  const dashboard = await ctx.db.select().from(sessions).where(eq(sessions.userId, userId));
  const forwardAuth = await ctx.db
    .select()
    .from(forwardAuthSessions)
    .where(eq(forwardAuthSessions.userId, userId));
  return { sessions: dashboard.length, forwardAuth: forwardAuth.length };
}

let otherId = 100;

/** Never id 1: on a fresh table the sequence would hand it out, and that is the admin's id. */
async function seedOtherUser(email: string, username: string | null) {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(users)
    .values({
      id: ++otherId,
      email,
      username,
      displayUsername: username,
      role: 'user',
      provider: 'credentials',
      subject: email,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row.id;
}

beforeEach(async () => {
  await ctx.db.delete(forwardAuthSessions);
  await ctx.db.delete(sessions);
  await ctx.db.delete(proxyHosts);
  await ctx.db.delete(accounts);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);
  ctx.env.adminUsername = 'admin';
  ctx.env.adminPassword = 'Env-Password-2026!';
});

describe('ensureAdminUser', () => {
  it('keeps a password changed in the UI across restarts', async () => {
    await ensureAdminUser();
    expect(await verifyPassword('Env-Password-2026!', await adminHash())).toBe(true);

    const uiHash = await setAdminPassword('Changed-In-Ui-2026!');

    await ensureAdminUser();
    expect(await adminHash()).toBe(uiHash);
    expect(await accountHash()).toBe(uiHash);
  });

  it('applies new environment credentials when they change', async () => {
    await ensureAdminUser();
    await setAdminPassword('Changed-In-Ui-2026!');
    await ctx.db.update(users).set({ role: 'user' }).where(eq(users.id, 1));

    ctx.env.adminPassword = 'Recovery-Password-2026!';
    await ensureAdminUser();

    const row = await adminRow();
    expect(await verifyPassword('Recovery-Password-2026!', row.passwordHash!)).toBe(true);
    expect(await verifyPassword('Recovery-Password-2026!', await accountHash())).toBe(true);
    expect(row.role).toBe('admin');
  });

  it('re-activates a disabled primary admin when the environment credentials change', async () => {
    await ensureAdminUser();
    await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, 1));

    ctx.env.adminPassword = 'Recovery-Password-2026!';
    await ensureAdminUser();

    expect((await adminRow()).status).toBe('active');
  });

  it("ends the admin's existing sessions when the environment sets a new password", async () => {
    await ensureAdminUser();
    const other = await seedOtherUser('other@example.com', 'other');
    await signIn(1);
    await signIn(other);

    ctx.env.adminPassword = 'Recovery-Password-2026!';
    await ensureAdminUser();

    expect(await sessionCounts(1)).toEqual({ sessions: 0, forwardAuth: 0 });
    expect(await sessionCounts(other)).toEqual({ sessions: 1, forwardAuth: 1 });
  });

  it('keeps sessions when the applied password is unchanged', async () => {
    await ensureAdminUser();
    await signIn(1);

    ctx.env.adminUsername = 'root';
    await ensureAdminUser();

    expect((await adminRow()).username).toBe('root');
    expect(await sessionCounts(1)).toEqual({ sessions: 1, forwardAuth: 1 });
  });

  it('does not re-apply the environment on a restart with the same values', async () => {
    await ensureAdminUser();
    const uiHash = await setAdminPassword('Changed-In-Ui-2026!');
    await ctx.db.update(users).set({ role: 'user' }).where(eq(users.id, 1));

    await ensureAdminUser();

    const row = await adminRow();
    expect(row.passwordHash).toBe(uiHash);
    expect(row.role).toBe('user');
  });

  it('records the applied credentials as a password hash, not the password', async () => {
    await ensureAdminUser();

    const marker = (await storedMarker()) as { v: number; username: string; passwordHash: string };
    expect(marker.v).toBe(2);
    expect(marker.username).toBe('admin');
    expect(await verifyPassword('Env-Password-2026!', marker.passwordHash)).toBe(true);
    expect(JSON.stringify(marker)).not.toContain('Env-Password-2026!');
  });

  describe('an ADMIN_USERNAME another account already signs in with', () => {
    it.each([
      ['root', 'ops@example.com'],
      ['root@localhost', 'ops@example.com'],
      [null, 'root'],
      [null, 'root@localhost'],
      [null, 'Root@LOCALHOST'],
    ])(
      'is not applied while another account has username %p or email %p',
      async (username, email) => {
        await ensureAdminUser();
        const otherId = await seedOtherUser(email, username);
        const before = await adminRow();
        const marker = await storedMarker();

        ctx.env.adminUsername = 'Root';
        ctx.env.adminPassword = 'Recovery-Password-2026!';
        await expect(ensureAdminUser()).rejects.toThrow(/ADMIN_USERNAME "Root" is not applied/);

        // Nothing is written, so the next start tries again.
        expect(await adminRow()).toEqual(before);
        expect(await storedMarker()).toEqual(marker);
        const [other] = await ctx.db.select().from(users).where(eq(users.id, otherId));
        expect(other).toMatchObject({ email, username });
      },
    );

    it('is not applied on the first start without a marker either', async () => {
      await ensureAdminUser();
      await forgetMarker();
      await setAdminPassword('Changed-In-Ui-2026!');
      await seedOtherUser('ops@example.com', 'root');

      ctx.env.adminUsername = 'root';
      await expect(ensureAdminUser()).rejects.toThrow(/is not applied/);
      expect((await adminRow()).username).toBe('admin');
    });

    // An OIDC-only start seeds no admin, so the first person to sign in is id 1.
    it('never rewrites an id 1 account the environment did not create', async () => {
      const now = new Date().toISOString();
      await ctx.db.insert(users).values({
        id: 1,
        email: 'first@example.com',
        name: 'First Sign-in',
        role: 'viewer',
        provider: 'oidc',
        subject: 'idp|first',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const before = await adminRow();

      await expect(ensureAdminUser()).rejects.toThrow(/user #1 \(first@example.com\)/);
      expect(await adminRow()).toEqual(before);
      expect(await storedMarker()).toBeNull();
    });

    it('does not create the primary admin with it', async () => {
      await seedOtherUser('ops@example.com', 'admin');

      await expect(ensureAdminUser()).rejects.toThrow(/ADMIN_USERNAME "admin" is not applied/);
      expect(await adminRow()).toBeUndefined();
    });

    it('still applies other environment changes when the admin keeps its username', async () => {
      await ensureAdminUser();
      // An older duplicate is left for an administrator to resolve.
      await seedOtherUser('ops@example.com', 'admin');

      ctx.env.adminPassword = 'Recovery-Password-2026!';
      await ensureAdminUser();

      expect(await verifyPassword('Recovery-Password-2026!', await adminHash())).toBe(true);
    });
  });

  describe('first start without a marker (upgrade)', () => {
    it('keeps a password that no longer matches the environment, and says so', async () => {
      await ensureAdminUser();
      await forgetMarker();
      const uiHash = await setAdminPassword('Changed-In-Ui-2026!');
      const warn = vi.spyOn(console, 'warn');

      try {
        await ensureAdminUser();
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/ADMIN_PASSWORD differs from the stored admin password/),
        );
      } finally {
        warn.mockRestore();
      }
      expect(await adminHash()).toBe(uiHash);
      expect(await accountHash()).toBe(uiHash);
    });

    it('applies an environment password changed at upgrade time once it is changed again', async () => {
      await ensureAdminUser();
      await forgetMarker();
      const uiHash = await setAdminPassword('Changed-In-Ui-2026!');

      ctx.env.adminPassword = 'Changed-At-Upgrade-2026!';
      await ensureAdminUser();
      expect(await adminHash()).toBe(uiHash);

      // Restarting with the same environment keeps the stored password...
      await ensureAdminUser();
      expect(await adminHash()).toBe(uiHash);

      // ...and changing it again applies it.
      ctx.env.adminPassword = 'Changed-Again-2026!';
      await ensureAdminUser();
      expect(await verifyPassword('Changed-Again-2026!', await adminHash())).toBe(true);
    });

    it.each(['Your-Secure-P@ssw0rd-Here!', 'YourStr0ng-P@ssw0rd123!', 'admin'])(
      'replaces the publicly known password %s with the environment one',
      async (publicPassword) => {
        await ensureAdminUser();
        await forgetMarker();
        await setAdminPassword(publicPassword);
        await signIn(1);

        ctx.env.adminPassword = 'Operator-Chosen-2026!';
        await ensureAdminUser();

        expect(await verifyPassword('Operator-Chosen-2026!', await adminHash())).toBe(true);
        expect(await verifyPassword('Operator-Chosen-2026!', await accountHash())).toBe(true);
        expect(await sessionCounts(1)).toEqual({ sessions: 0, forwardAuth: 0 });

        // Later restarts keep it.
        await ensureAdminUser();
        expect(await verifyPassword('Operator-Chosen-2026!', await adminHash())).toBe(true);
      },
    );

    it('applies the environment when it matches the stored password', async () => {
      await ensureAdminUser();
      await forgetMarker();
      await ctx.db.update(users).set({ role: 'user' }).where(eq(users.id, 1));
      const hash = await adminHash();

      await ensureAdminUser();

      const row = await adminRow();
      expect(row.role).toBe('admin');
      expect(row.passwordHash).toBe(hash);
      expect(await storedMarker()).toMatchObject({ v: 2, username: 'admin' });
    });

    it('leaves a disabled primary admin disabled when the environment is unchanged', async () => {
      await ensureAdminUser();
      await forgetMarker();
      await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, 1));

      await ensureAdminUser();
      expect((await adminRow()).status).toBe('disabled');

      // Later restarts, now with a marker, keep it disabled too.
      await ensureAdminUser();
      expect((await adminRow()).status).toBe('disabled');
    });

    it('makes the admin active again when it replaces a publicly known password', async () => {
      await ensureAdminUser();
      await forgetMarker();
      await setAdminPassword('admin');
      await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, 1));

      await ensureAdminUser();

      expect((await adminRow()).status).toBe('active');
    });

    it('applies a changed ADMIN_USERNAME while keeping a password changed in the UI', async () => {
      await ensureAdminUser();
      await forgetMarker();
      const uiHash = await setAdminPassword('Changed-In-Ui-2026!');
      await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, 1));

      ctx.env.adminUsername = 'Root';
      await ensureAdminUser();

      const row = await adminRow();
      expect(row).toMatchObject({
        username: 'root',
        displayUsername: 'Root',
        email: 'Root@localhost',
        subject: 'Root',
        status: 'disabled',
      });
      expect(row.passwordHash).toBe(uiHash);
      expect(await accountHash()).toBe(uiHash);

      // Later restarts keep both.
      await ensureAdminUser();
      expect(await adminRow()).toMatchObject({ username: 'root', passwordHash: uiHash });
    });

    it('treats a value that is not a marker (such as an older fingerprint) as no marker', async () => {
      await ensureAdminUser();
      await ctx.db
        .update(settings)
        .set({ value: JSON.stringify('9f2c'.repeat(16)) })
        .where(eq(settings.key, MARKER_KEY));
      const uiHash = await setAdminPassword('Changed-In-Ui-2026!');

      await ensureAdminUser();

      expect(await adminHash()).toBe(uiHash);
      expect(await storedMarker()).toMatchObject({ v: 2, username: 'admin' });
    });
  });
});
