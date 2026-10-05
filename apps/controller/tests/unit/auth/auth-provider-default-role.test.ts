/**
 * A stored provider's "role when no group matches" must survive getAuth()'s load, every role
 * included: the load once coerced "operator" to "user".
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  configs: [] as Array<{ providerId: string; mapProfileToUser?: (p: unknown) => unknown }>,
}));

const { createTestDb } = await import('../../helpers/db');

// Outside the factory: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: (options: { config: typeof ctx.configs }) => {
    ctx.configs = options.config;
    return {};
  },
  username: () => ({}),
}));

import { getAuth, invalidateProviderCache } from '../../../src/lib/auth/server';
import { oauthProviders } from '../../../src/lib/db/schema';
import { createOAuthProvider } from '../../../src/lib/models/oauth-providers';
import {
  clearPendingOidcSyncs,
  consumePendingOidcSync,
} from '../../../src/lib/services/oidc-group-sync';

beforeEach(async () => {
  clearPendingOidcSyncs();
  await ctx.db.delete(oauthProviders);
  invalidateProviderCache();
});

describe('getAuth - stored default role', () => {
  for (const role of ['admin', 'operator', 'user', 'viewer'] as const) {
    it(`keeps "${role}" for a sign-in that matches no role group`, async () => {
      const provider = await createOAuthProvider({
        name: `IdP ${role}`,
        clientId: 'cid',
        clientSecret: 'secret',
        issuer: 'https://idp.example/',
        roleMappingEnabled: true,
        adminGroup: 'cpm-admins',
        defaultRole: role,
      });

      await getAuth();
      const cfg = ctx.configs.find((c) => c.providerId === provider.id);
      expect(cfg?.mapProfileToUser).toBeDefined();
      await cfg!.mapProfileToUser!({ sub: 'someone', emailVerified: false, groups: ['staff'] });

      expect(consumePendingOidcSync(provider.id, 'someone')?.role).toBe(role);
    });
  }
});
