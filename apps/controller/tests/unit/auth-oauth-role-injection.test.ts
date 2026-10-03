/**
 * SECURITY-AUDIT H3: better-auth's generic-OAuth signup spreads raw IdP claims into the new user,
 * ignoring `input:false`, so a databaseHooks.user.create.before hook forces safe defaults.
 */
import { describe, it, expect } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted out of the factory: a Bun mock factory must be synchronous, or the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

// The real better-auth fails to resolve under the test runner; this `betterAuth` returns its
// options, so getAuth().options is exactly what createAuth() built, real databaseHooks included.
vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

import { enforceSafeUserDefaults, getAuth, mapOAuthProvider } from '../../src/lib/auth-server';
import type { OAuthProvider } from '../../src/lib/models/oauth-providers';

describe('enforceSafeUserDefaults', () => {
  it('forces role and status to safe defaults', () => {
    const out = enforceSafeUserDefaults({
      email: 'x@y.z',
      name: 'X',
      role: 'admin',
      status: 'active',
    });
    expect(out.role).toBe('user');
    expect(out.status).toBe('active');
  });

  it('overrides malicious role/status injected via OAuth claims', () => {
    const out = enforceSafeUserDefaults({
      email: 'evil@idp.example',
      role: 'admin',
      status: 'whatever',
    } as Record<string, unknown>);
    expect(out.role).toBe('user');
    expect(out.status).toBe('active');
  });

  it('preserves non-privileged identity fields', () => {
    const out = enforceSafeUserDefaults({
      email: 'a@b.c',
      name: 'Alice',
      image: 'https://img.example/a.png',
      emailVerified: true,
    } as Record<string, unknown>) as Record<string, unknown>;
    expect(out.email).toBe('a@b.c');
    expect(out.name).toBe('Alice');
    expect(out.image).toBe('https://img.example/a.png');
    expect(out.emailVerified).toBe(true);
    expect(out.role).toBe('user');
  });
});

describe('better-auth user.create.before hook (wired into the real config)', () => {
  it('is configured as a function', async () => {
    const auth = (await getAuth()) as any;
    const hook = auth.options?.databaseHooks?.user?.create?.before;
    expect(typeof hook).toBe('function');
  });

  it('forces role/status to safe defaults on a malicious OAuth-style user create', async () => {
    const auth = (await getAuth()) as any;
    const hook = auth.options.databaseHooks.user.create.before;

    const result = await hook({
      email: 'attacker@evil-idp.example',
      name: 'Mallory',
      role: 'admin', // injected by a hostile IdP
      status: 'active',
    });

    expect(result.data.role).toBe('user');
    expect(result.data.status).toBe('active');
    expect(result.data.email).toBe('attacker@evil-idp.example'); // identity preserved
  });
});

describe('mapOAuthProvider - OAuth self-registration gating (M2)', () => {
  const sampleProvider: OAuthProvider = {
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
    source: 'ui',
    groupsClaim: 'groups',
    groupPrefix: null,
    roleMappingEnabled: false,
    adminGroup: null,
    operatorGroup: null,
    userGroup: null,
    viewerGroup: null,
    defaultRole: 'user',
    syncGroups: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('disables implicit signup by default (AUTH_ALLOW_OAUTH_REGISTRATION unset)', () => {
    // AUTH_ALLOW_OAUTH_REGISTRATION is unset in tests, so an unknown IdP identity cannot sign up.
    const cfg = mapOAuthProvider(sampleProvider);
    expect(cfg.disableImplicitSignUp).toBe(true);
  });

  it('turns a configured issuer into a discovery URL, and passes no issuer of its own', () => {
    const cfg = mapOAuthProvider(sampleProvider);

    expect(cfg.discoveryUrl).toBe('https://idp.example/.well-known/openid-configuration');
    expect(cfg).not.toHaveProperty('issuer');
  });

  it('uses the explicit endpoints when a provider declares no issuer', () => {
    const cfg = mapOAuthProvider({
      ...sampleProvider,
      id: 'team/provider',
      issuer: null,
      authorizationUrl: 'https://idp.example/authorize',
      tokenUrl: 'https://idp.example/token',
    });

    expect(cfg.authorizationUrl).toBe('https://idp.example/authorize');
    expect(cfg.tokenUrl).toBe('https://idp.example/token');
    expect(cfg.discoveryUrl).toBeUndefined();
  });
});
