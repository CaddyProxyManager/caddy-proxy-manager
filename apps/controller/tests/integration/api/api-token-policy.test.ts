/**
 * What binds a token beyond its scope: its owner's two-factor policy, the per-account limit under
 * concurrent creates, and an expiry that never silently becomes "never".
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const { users, apiTokens } = await import('../../../src/lib/db/schema');
const { createApiToken, MAX_TOKENS_PER_USER } = await import('../../../src/lib/models/api-tokens');
const { authenticateApiRequest } = await import('../../../src/lib/api/auth');
const { setSetting } = await import('../../../src/lib/settings');
const { invalidateSettingsCache } = await import('../../../src/lib/settings/resolve');
const { resolveTokenExpiry, tokenExpiryPreset, DEFAULT_TOKEN_EXPIRY } = await import(
  '../../../src/lib/api-tokens/expiry'
);

const DAY = 86_400_000;

async function user(overrides: Partial<typeof users.$inferInsert> = {}) {
  const now = new Date(Date.now() - 30 * DAY).toISOString();
  const [row] = await ctx.db
    .insert(users)
    .values({
      email: 'admin@localhost',
      name: 'Admin',
      passwordHash: 'hash',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@localhost',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .returning();
  return row;
}

async function policy(mode: 'off' | 'all', sinceDaysAgo: number, graceDays = 7) {
  await setSetting('two_factor_policy', {
    mode,
    graceDays,
    since: new Date(Date.now() - sinceDaysAgo * DAY).toISOString(),
    requireForAdmins: mode !== 'off',
  });
  invalidateSettingsCache();
}

function bearer(token: string) {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? `Bearer ${token}` : null) },
    method: 'GET',
    nextUrl: { pathname: '/api/v1/proxy-hosts' },
  } as never;
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  invalidateSettingsCache();
});

describe('the owner two-factor policy', () => {
  it('refuses a bearer token once its owner is past the grace period', async () => {
    const owner = await user();
    const { rawToken } = await createApiToken('ci', owner.id);
    await expect(authenticateApiRequest(bearer(rawToken))).resolves.toMatchObject({
      userId: owner.id,
    });

    await policy('all', 30);
    await expect(authenticateApiRequest(bearer(rawToken))).rejects.toMatchObject({ status: 403 });

    await ctx.db.update(users).set({ twoFactorEnabled: true });
    await expect(authenticateApiRequest(bearer(rawToken))).resolves.toMatchObject({
      userId: owner.id,
    });
  });

  it('refuses to mint a token in the grace period, and lets an exempt account through', async () => {
    const owner = await user();
    await policy('all', 1);
    await expect(createApiToken('ci', owner.id)).rejects.toMatchObject({
      code: 'apiTokenNeedsSecondFactor',
    });
    const sso = await user({
      email: 'sso@localhost',
      subject: 'sso',
      provider: 'oidc',
      passwordHash: null,
    });
    await expect(createApiToken('ci', sso.id)).resolves.toBeDefined();
  });
});

describe('the token limit', () => {
  it('holds under concurrent creates', async () => {
    const owner = await user();
    const results = await Promise.allSettled(
      Array.from({ length: MAX_TOKENS_PER_USER + 5 }, (_, i) => createApiToken(`t${i}`, owner.id)),
    );
    const stored = await ctx.db.select().from(apiTokens);
    expect(stored.length).toBeLessThanOrEqual(MAX_TOKENS_PER_USER);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(stored.length);
  });
});

describe('token expiry presets', () => {
  it('falls back to the default rather than never', () => {
    expect(tokenExpiryPreset('forever')).toBe(DEFAULT_TOKEN_EXPIRY);
    expect(tokenExpiryPreset(undefined)).toBe('90d');
    const now = new Date('2026-01-01T00:00:00Z');
    expect(resolveTokenExpiry(tokenExpiryPreset('bogus'), undefined, now)).toBe(
      new Date(now.getTime() + 90 * DAY).toISOString(),
    );
  });

  it('refuses a custom expiry without a date', () => {
    expect(() => resolveTokenExpiry('custom', undefined)).toThrow();
    expect(() => resolveTokenExpiry('custom', '  ')).toThrow();
    expect(resolveTokenExpiry('custom', '2027-01-01T00:00:00Z')).toBe('2027-01-01T00:00:00Z');
  });
});
