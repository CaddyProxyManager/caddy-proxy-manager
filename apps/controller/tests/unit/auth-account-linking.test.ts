/**
 * Regression (#247): linking always failed with `account_not_linked` - no `accountLinking` config,
 * and `autoLink` never reached auth. Auto-link providers are trusted; others cannot claim accounts.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// Bun mock factories run synchronously, so their helpers are imported up here.
const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

const now = '2026-01-01T00:00:00.000Z';
// At module scope, since the factory below cannot await.
await ctx.db.insert(schemaModule.oauthProviders).values([
  {
    id: 'autolink-idp',
    name: 'Auto-link IdP',
    type: 'oidc',
    clientId: 'cid-a',
    clientSecret: 'secret-a',
    issuer: 'https://autolink.example',
    scopes: 'openid email profile',
    autoLink: true,
    enabled: true,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'manual-idp',
    name: 'Manual IdP',
    type: 'oidc',
    clientId: 'cid-b',
    clientSecret: 'secret-b',
    issuer: 'https://manual.example',
    scopes: 'openid email profile',
    autoLink: false,
    enabled: true,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'disabled-idp',
    name: 'Disabled IdP',
    type: 'oidc',
    clientId: 'cid-c',
    clientSecret: 'secret-c',
    issuer: 'https://disabled.example',
    scopes: 'openid email profile',
    autoLink: true,
    enabled: false,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  },
]);

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

// `betterAuth(options)` returns the raw options, so getAuth().options is createAuth()'s config.
vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

// Only whether the flow is an explicit link is mocked; the rest of the module stays real.
const { getOAuthStateMock } = vi.hoisted(() => ({ getOAuthStateMock: vi.fn() }));
const actualApi = await import('better-auth/api');
vi.mock('better-auth/api', () => ({ ...actualApi, getOAuthState: getOAuthStateMock }));

import { getAuth, mapOAuthProvider } from '../../src/lib/auth-server';
import type { OAuthProvider } from '../../src/lib/models/oauth-providers';

const baseProvider: OAuthProvider = {
  id: 'p1',
  name: 'Some IdP',
  type: 'oidc',
  clientId: 'cid',
  clientSecret: 'secret',
  issuer: 'https://idp.example/',
  authorizationUrl: null,
  tokenUrl: null,
  userinfoUrl: null,
  scopes: 'openid email profile',
  autoLink: false,
  enabled: true,
  groupsClaim: 'groups',
  groupPrefix: null,
  roleMappingEnabled: false,
  adminGroup: null,
  operatorGroup: null,
  userGroup: null,
  viewerGroup: null,
  defaultRole: 'user',
  syncGroups: false,
  source: 'ui',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

async function mapProfile(provider: OAuthProvider, profile: Record<string, unknown>): Promise<any> {
  const mapper = mapOAuthProvider(provider).mapProfileToUser;
  expect(typeof mapper).toBe('function');

  return await mapper!(profile as any);
}

describe('mapOAuthProvider - email_verified claim mapping', () => {
  it('reports the OIDC claim for an auto-link provider', async () => {
    const mapped = await mapProfile(
      { ...baseProvider, autoLink: true },
      { email: 'user@example.com', email_verified: true },
    );
    expect(mapped.emailVerified).toBe(true);
  });

  it('accepts a string-encoded claim from providers that serialize it that way', async () => {
    const mapped = await mapProfile(
      { ...baseProvider, autoLink: true },
      { email: 'user@example.com', email_verified: 'true' },
    );
    expect(mapped.emailVerified).toBe(true);
  });

  it('reports false when an auto-link provider does not verify the email', async () => {
    const mapped = await mapProfile(
      { ...baseProvider, autoLink: true },
      { email: 'user@example.com' },
    );
    expect(mapped.emailVerified).toBe(false);
  });

  it('never lets a provider without auto-link assert a verified email', async () => {
    const mapped = await mapProfile(
      { ...baseProvider, autoLink: false },
      { email: 'victim@example.com', email_verified: true },
    );
    expect(mapped.emailVerified).toBe(false);
  });

  it('lets a signed-in user link a provider without auto-link from their profile', async () => {
    // The session proves the owner; auto-link governs only a sign-in claiming by email.
    getOAuthStateMock.mockResolvedValueOnce({ link: { userId: '1', email: 'admin@localhost' } });
    const mapped = await mapProfile(
      { ...baseProvider, autoLink: false },
      { email: 'someone@idp.example' },
    );
    expect(mapped.emailVerified).toBe(true);
  });

  it('still refuses a sign-in claiming an account through a provider without auto-link', async () => {
    getOAuthStateMock.mockResolvedValueOnce({ callbackURL: '/', link: undefined });
    const mapped = await mapProfile(
      { ...baseProvider, autoLink: false },
      { email: 'victim@example.com', email_verified: true },
    );
    expect(mapped.emailVerified).toBe(false);
  });

  it('falls back to the auto-link rule when there is no OAuth request state', async () => {
    getOAuthStateMock.mockRejectedValueOnce(new Error('No request state found'));
    const mapped = await mapProfile(
      { ...baseProvider, autoLink: false },
      { email: 'victim@example.com', email_verified: true },
    );
    expect(mapped.emailVerified).toBe(false);
  });

  it('leaves identity fields to Better Auth rather than overriding them', async () => {
    const mapped = await mapProfile(
      { ...baseProvider, autoLink: true },
      { email: 'user@example.com', email_verified: true, name: 'User', role: 'admin' },
    );
    expect(Object.keys(mapped)).toEqual(['emailVerified']);
  });
});

describe('better-auth account.accountLinking (wired into the real config)', () => {
  // getAuth() is async, so resolve once in beforeAll.
  let options: any;
  beforeAll(async () => {
    options = ((await getAuth()) as any).options;
  });

  it('enables account linking', () => {
    expect(options.account.accountLinking.enabled).toBe(true);
  });

  it('does not gate on a local emailVerified flag CPM can never set', () => {
    // No email-verification flow, so the default `true` refuses every link (#247).
    expect(options.account.accountLinking.requireLocalEmailVerified).toBe(false);
  });

  it('trusts exactly the enabled providers with auto-link turned on', () => {
    expect(options.account.accountLinking.trustedProviders).toEqual(['autolink-idp']);
  });

  it('does not implicitly disable linking', () => {
    expect(options.account.accountLinking.disableImplicitLinking).toBeUndefined();
  });

  it('lets an explicit link use a provider email that differs from the account', () => {
    // Setup's admin is `name@localhost`, which no provider returns; only explicit links read it.
    expect(options.account.accountLinking.allowDifferentEmails).toBe(true);
  });
});
