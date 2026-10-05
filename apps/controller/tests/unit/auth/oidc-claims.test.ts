/**
 * Claim resolution for group-mapping providers. The interesting case is the one better-auth's
 * default cannot handle: an ID token identifying the user but carrying no group claim.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import {
  clearDiscoveryCache,
  decodeJwtPayload,
  fetchOidcClaims,
  resolveUserinfoUrl,
  toOAuthUserInfo,
} from '../../../src/lib/auth/oidc/claims';

function makeIdToken(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearDiscoveryCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('decodeJwtPayload', () => {
  it('decodes a base64url payload', () => {
    const token = makeIdToken({ sub: 'abc', groups: ['CPM_Admin'] });
    expect(decodeJwtPayload(token)).toEqual({ sub: 'abc', groups: ['CPM_Admin'] });
  });

  it('returns null for anything that is not a JWT', () => {
    expect(decodeJwtPayload(null)).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('a.!!!.c')).toBeNull();
  });
});

describe('resolveUserinfoUrl', () => {
  it('prefers an explicitly configured endpoint over discovery', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const url = await resolveUserinfoUrl({
      issuer: 'https://idp.example',
      userinfoUrl: 'https://idp.example/custom-userinfo',
    });

    expect(url).toBe('https://idp.example/custom-userinfo');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers the endpoint from the issuer and caches the result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ userinfo_endpoint: 'https://idp.example/userinfo' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cfg = { issuer: 'https://idp.example/', userinfoUrl: null };
    expect(await resolveUserinfoUrl(cfg)).toBe('https://idp.example/userinfo');
    expect(await resolveUserinfoUrl(cfg)).toBe('https://idp.example/userinfo');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://idp.example/.well-known/openid-configuration');
  });

  it('returns null when there is nothing to discover from', async () => {
    expect(await resolveUserinfoUrl({ issuer: null, userinfoUrl: null })).toBeNull();
  });
});

describe('fetchOidcClaims', () => {
  const cfg = { issuer: null, userinfoUrl: 'https://idp.example/userinfo' };

  it('uses the ID token alone when it already carries the group claim', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const claims = await fetchOidcClaims(
      cfg,
      { idToken: makeIdToken({ sub: 'u1', email: 'u1@example.com', groups: ['CPM_Admin'] }) },
      'groups',
    );

    expect(claims).toMatchObject({ sub: 'u1', groups: ['CPM_Admin'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to userinfo when the ID token has no group claim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ groups: ['CPM_Admin'] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const claims = await fetchOidcClaims(
      cfg,
      { idToken: makeIdToken({ sub: 'u1', email: 'u1@example.com' }), accessToken: 'token-123' },
      'groups',
    );

    expect(claims).toMatchObject({ sub: 'u1', email: 'u1@example.com', groups: ['CPM_Admin'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token-123');
  });

  it('works with no ID token at all, from userinfo only', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ sub: 'u2', email: 'u2@example.com', groups: ['CPM_User'] }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const claims = await fetchOidcClaims(cfg, { accessToken: 'token-123' }, 'groups');

    expect(claims).toMatchObject({ sub: 'u2', groups: ['CPM_User'] });
  });

  it('keeps the identity from the ID token when userinfo cannot be reached', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const claims = await fetchOidcClaims(
      cfg,
      { idToken: makeIdToken({ sub: 'u1', email: 'u1@example.com' }), accessToken: 'token-123' },
      'groups',
    );

    expect(claims).toMatchObject({ sub: 'u1', email: 'u1@example.com' });
    expect(claims?.groups).toBeUndefined();
  });

  it('returns null when no identity can be established', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({})) as unknown as typeof fetch;

    expect(await fetchOidcClaims(cfg, { accessToken: 'token-123' }, 'groups')).toBeNull();
  });

  it('resolves a nested group claim without a redundant userinfo call', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const claims = await fetchOidcClaims(
      cfg,
      {
        idToken: makeIdToken({
          sub: 'u1',
          email: 'u1@example.com',
          resource_access: { cpm: { roles: ['CPM_Admin'] } },
        }),
      },
      'resource_access.cpm.roles',
    );

    expect(claims).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('toOAuthUserInfo', () => {
  it('maps standard claims onto the shape better-auth expects, keeping the rest', () => {
    const info = toOAuthUserInfo({
      sub: 'u1',
      email: 'u1@example.com',
      email_verified: true,
      picture: 'https://img.example/a.png',
      name: 'User One',
      groups: ['CPM_Admin'],
    });

    expect(info).toMatchObject({
      id: 'u1',
      email: 'u1@example.com',
      emailVerified: true,
      image: 'https://img.example/a.png',
      name: 'User One',
      groups: ['CPM_Admin'],
    });
  });

  it('falls back to preferred_username when no name claim is present', () => {
    const info = toOAuthUserInfo({
      sub: 'u1',
      email: 'u1@example.com',
      preferred_username: 'uone',
    });
    expect(info.name).toBe('uone');
    expect(info.emailVerified).toBe(false);
  });
});
