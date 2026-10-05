/**
 * Wiring check for group mapping: the hooks attach only when a provider asks for it, and the
 * profile hook parks a result the sign-in picks up. Mapping rules live in oidc-groups.test.ts.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Outside the factory: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

import { eq } from 'drizzle-orm';
import { mapOAuthProvider } from '../../../src/lib/auth/server';
import { accounts, groupMembers, groups, users } from '../../../src/lib/db/schema';
import type { OAuthProvider } from '../../../src/lib/models/oauth-providers';
import {
  clearPendingOidcSyncs,
  consumePendingOidcSync,
  reconcileOidcUserAfterSignIn,
} from '../../../src/lib/services/oidc-group-sync';

function provider(overrides: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    id: 'authentik',
    name: 'Authentik',
    type: 'oidc',
    clientId: 'cid',
    clientSecret: 'secret',
    issuer: 'https://idp.example/',
    authorizationUrl: null,
    tokenUrl: null,
    userinfoUrl: null,
    scopes: 'openid email profile groups',
    autoLink: false,
    enabled: true,
    source: 'ui',
    groupsClaim: 'groups',
    groupPrefix: 'CPM_',
    roleMappingEnabled: false,
    adminGroup: null,
    operatorGroup: null,
    userGroup: null,
    viewerGroup: null,
    defaultRole: 'user',
    syncGroups: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Fills the OIDC fields these tests do not care about. */
function profile(claims: Record<string, unknown>) {
  return { emailVerified: false, ...claims } as Parameters<
    NonNullable<ReturnType<typeof mapOAuthProvider>['mapProfileToUser']>
  >[0];
}

beforeEach(() => {
  clearPendingOidcSyncs();
});

describe('mapOAuthProvider - group mapping hooks', () => {
  it('attaches no claim hooks for a provider that does not use groups', async () => {
    const cfg = mapOAuthProvider(provider());
    expect(cfg.getUserInfo).toBeUndefined();
    // Always present for the auto-link gate; what matters is it ignores the group claim.
    expect(await cfg.mapProfileToUser?.({ groups: ['CPM_Admin'] } as never)).toEqual({
      emailVerified: false,
    });
  });

  it('attaches them when role mapping is on', () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true }));
    expect(typeof cfg.getUserInfo).toBe('function');
    expect(typeof cfg.mapProfileToUser).toBe('function');
  });

  it('attaches them when only group sync is on', () => {
    const cfg = mapOAuthProvider(provider({ syncGroups: true }));
    expect(typeof cfg.getUserInfo).toBe('function');
  });

  it('records the mapped role for the subject in the profile', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true }));

    await cfg.mapProfileToUser!(
      profile({
        sub: 'user-1',
        email: 'dev@example.com',
        groups: ['CPM_Admin', 'CPM_Devs'],
      }),
    );

    const pending = consumePendingOidcSync('authentik', 'user-1');
    expect(pending).not.toBeNull();
    expect(pending!.role).toBe('admin');
    expect(pending!.providerName).toBe('Authentik');
  });

  it('records the mirrored group names when group sync is on', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true, syncGroups: true }));

    await cfg.mapProfileToUser!(
      profile({
        sub: 'user-1',
        email: 'dev@example.com',
        groups: ['CPM_Admin', 'CPM_Devs', 'Unrelated'],
      }),
    );

    const pending = consumePendingOidcSync('authentik', 'user-1');
    expect(pending!.localGroups).toEqual(['Devs']);
    expect(pending!.syncGroups).toBe(true);
  });

  it('never returns privileged fields to better-auth from the IdP profile', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true }));

    const mapped = await cfg.mapProfileToUser!(
      profile({
        sub: 'user-1',
        email: 'evil@example.com',
        role: 'admin',
        status: 'active',
        groups: [],
      }),
    );

    expect(mapped).not.toHaveProperty('role');
    expect(mapped).not.toHaveProperty('status');
    // Reported so better-auth cannot fall back to the profile's own emailVerified.
    expect(mapped).toEqual({ emailVerified: false });
  });

  it('still gates emailVerified on auto-link once group mapping is on', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true, autoLink: true }));

    const mapped = await cfg.mapProfileToUser!(
      profile({ sub: 'user-1', email: 'dev@example.com', email_verified: true, groups: [] }),
    );

    expect(mapped).toEqual({ emailVerified: true });
  });

  it('reports emailVerified false for a non-auto-link provider claiming a verified email', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true, autoLink: false }));

    const mapped = await cfg.mapProfileToUser!(
      profile({ sub: 'user-1', email: 'dev@example.com', email_verified: true, groups: [] }),
    );

    expect(mapped).toEqual({ emailVerified: false });
  });

  it('records the role from custom group names configured without a prefix', async () => {
    const cfg = mapOAuthProvider(
      provider({
        roleMappingEnabled: true,
        groupPrefix: null,
        adminGroup: 'platform-owners, sre-oncall',
        operatorGroup: 'platform-owners, sre-oncall',
        userGroup: 'staff',
        viewerGroup: 'auditors',
      }),
    );

    await cfg.mapProfileToUser!(
      profile({
        sub: 'user-3',
        email: 'sre@example.com',
        groups: ['sre-oncall'],
      }),
    );

    expect(consumePendingOidcSync('authentik', 'user-3')!.role).toBe('admin');
  });

  it('records the default role for a user in none of the role groups', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true, defaultRole: 'viewer' }));

    await cfg.mapProfileToUser!(
      profile({ sub: 'user-2', email: 'x@example.com', groups: ['Marketing'] }),
    );

    expect(consumePendingOidcSync('authentik', 'user-2')!.role).toBe('viewer');
  });

  it('parks nothing when the profile has no subject to key on', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true }));

    await cfg.mapProfileToUser!(profile({ email: 'x@example.com', groups: ['CPM_Admin'] }));

    expect(consumePendingOidcSync('authentik', 'undefined')).toBeNull();
  });
});

/** better-auth maps the profile on every callback, so an IdP group change lands at next sign-in. */
describe('a repeat sign-in re-reads the group claim', () => {
  const now = '2026-01-01T00:00:00.000Z';

  async function seedReturningUser(role: string): Promise<number> {
    const [user] = await ctx.db
      .insert(users)
      .values({
        email: 'dev@example.com',
        name: 'Dev',
        role,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await ctx.db.insert(accounts).values({
      userId: user.id,
      accountId: 'user-1',
      providerId: 'authentik',
      createdAt: now,
      updatedAt: now,
    });
    return user.id;
  }

  async function signIn(
    cfg: ReturnType<typeof mapOAuthProvider>,
    groups: string[],
    userId: number,
  ) {
    await cfg.mapProfileToUser!(profile({ sub: 'user-1', email: 'dev@example.com', groups }));
    await reconcileOidcUserAfterSignIn(userId);
  }

  async function roleOf(userId: number): Promise<string> {
    const rows = await ctx.db.select().from(users).where(eq(users.id, userId));
    return rows[0].role;
  }

  beforeEach(async () => {
    await ctx.db.delete(groupMembers);
    await ctx.db.delete(groups);
    await ctx.db.delete(accounts);
    await ctx.db.delete(users);
  });

  it('promotes an existing account added to the admin group since it last signed in', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true }));
    const userId = await seedReturningUser('user');

    await signIn(cfg, ['CPM_Admin'], userId);

    expect(await roleOf(userId)).toBe('admin');
  });

  it('demotes an existing account removed from the admin group', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true }));
    // A second admin, so the last-admin safeguard does not hold the demotion back.
    await ctx.db.insert(users).values({
      email: 'other-admin@example.com',
      name: 'Other',
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const userId = await seedReturningUser('admin');

    await signIn(cfg, ['CPM_Devs'], userId);

    expect(await roleOf(userId)).toBe('user');
  });

  it('reconciles mirrored group membership on the repeat sign-in too', async () => {
    const cfg = mapOAuthProvider(provider({ roleMappingEnabled: true, syncGroups: true }));
    const userId = await seedReturningUser('user');

    await signIn(cfg, ['CPM_Devs', 'CPM_Ops'], userId);
    await signIn(cfg, ['CPM_Ops'], userId);

    const rows = await ctx.db
      .select({ name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(eq(groupMembers.userId, userId));
    expect(rows.map((r) => r.name)).toEqual(['Ops']);
  });
});
