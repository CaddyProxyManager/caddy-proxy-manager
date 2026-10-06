/**
 * Each check stands between an unauthenticated POST and deleted sessions, so tokens are really
 * signed and verified against a JWKS; a mocked `jwtVerify` would pass anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { vi } from '@/tests/helpers/vi';
import { clearDiscoveryCache } from '@/src/lib/auth/oidc/claims';
import { createTestDb } from '@/tests/helpers/db';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { spentNonces } from '@/src/lib/db/schema';

// Spent values are shared by every replica, so they live in the database.
const testDb = await createTestDb();
vi.mock('@/src/lib/db', () => dbModuleMock(() => testDb));
import {
  clearJwksCache,
  rememberLogoutJti,
  verifyLogoutToken,
} from '@/src/lib/auth/oidc/logout-token';

const ISSUER = 'https://idp.example';
const CLIENT_ID = 'cpm';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

const other = await generateKeyPair('RS256');

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Discovery and JWKS both come over fetch; serve them from the one stub. */
function serveIdp(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('.well-known/openid-configuration')) {
      return jsonResponse({ jwks_uri: `${ISSUER}/jwks`, userinfo_endpoint: `${ISSUER}/userinfo` });
    }
    if (url.includes('/jwks')) return jsonResponse({ keys: [jwk] });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

type Claims = Record<string, unknown>;

async function signLogoutToken(claims: Claims = {}, key = privateKey): Promise<string> {
  const {
    iss = ISSUER,
    aud = CLIENT_ID,
    events = { [LOGOUT_EVENT]: {} },
    iat,
    ...rest
  } = claims as Claims & { iss?: string; aud?: string; events?: unknown; iat?: number };

  let builder = new SignJWT({ events, ...rest })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime('2m');
  builder = iat === undefined ? builder.setIssuedAt() : builder.setIssuedAt(iat);
  return builder.sign(key);
}

const provider = { issuer: ISSUER, clientId: CLIENT_ID };

beforeEach(async () => {
  clearDiscoveryCache();
  clearJwksCache();
  await testDb.delete(spentNonces);
  serveIdp();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('verifyLogoutToken', () => {
  it('accepts a well-formed token and returns what it names', async () => {
    const token = await signLogoutToken({ sub: 'user-1', sid: 'session-9', jti: 'jti-1' });

    const result = await verifyLogoutToken(token, provider);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toEqual({
      issuer: ISSUER,
      subject: 'user-1',
      sessionId: 'session-9',
      jti: 'jti-1',
    });
  });

  it('accepts a token naming only a subject', async () => {
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1' });
    const result = await verifyLogoutToken(token, provider);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sessionId).toBeNull();
  });

  it('accepts a token naming only a session', async () => {
    const token = await signLogoutToken({ sid: 'session-9', jti: 'jti-1' });
    const result = await verifyLogoutToken(token, provider);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.subject).toBeNull();
  });

  it('rejects a token signed by a key the issuer does not publish', async () => {
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1' }, other.privateKey);

    expect((await verifyLogoutToken(token, provider)).ok).toBe(false);
  });

  it('rejects a token minted for another client', async () => {
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1', aud: 'someone-else' });

    expect((await verifyLogoutToken(token, provider)).ok).toBe(false);
  });

  it('rejects a token from another issuer', async () => {
    const token = await signLogoutToken({
      sub: 'user-1',
      jti: 'jti-1',
      iss: 'https://evil.example',
    });

    expect((await verifyLogoutToken(token, provider)).ok).toBe(false);
  });

  it('rejects an ID token replayed as a logout token', async () => {
    // A nonce binds an ID token to an auth request, so this was not minted as a logout token.
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1', nonce: 'n-1' });
    const result = await verifyLogoutToken(token, provider);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('nonce');
  });

  it('rejects a token whose events claim names no logout', async () => {
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1', events: {} });
    const result = await verifyLogoutToken(token, provider);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('events');
  });

  it('rejects a token naming neither a subject nor a session', async () => {
    const token = await signLogoutToken({ jti: 'jti-1' });
    const result = await verifyLogoutToken(token, provider);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('neither');
  });

  it('rejects a token with no jti to protect against replay with', async () => {
    const token = await signLogoutToken({ sub: 'user-1' });
    const result = await verifyLogoutToken(token, provider);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('jti');
  });

  it('rejects a token issued too long ago to still be in flight', async () => {
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1', iat: hourAgo });

    expect((await verifyLogoutToken(token, provider)).ok).toBe(false);
  });

  it('rejects a provider with no issuer to verify against', async () => {
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1' });
    const result = await verifyLogoutToken(token, { issuer: null, clientId: CLIENT_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('issuer');
  });

  it('rejects when discovery exposes no jwks_uri', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ userinfo_endpoint: `${ISSUER}/userinfo` })) as unknown as typeof fetch;
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1' });
    const result = await verifyLogoutToken(token, provider);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('jwks_uri');
  });

  // Authentik issues `iss` with a trailing slash; trimming it made jwtVerify refuse every token.
  it('accepts a token from an issuer whose identifier ends in a slash', async () => {
    const slashed = `${ISSUER}/`;
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1', iss: slashed });

    const result = await verifyLogoutToken(token, { issuer: slashed, clientId: CLIENT_ID });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.issuer).toBe(slashed);
  });

  it('still refuses a token whose issuer differs from the configured one', async () => {
    // Different issuers to the spec, so the mismatch is a misconfiguration worth reporting.
    const token = await signLogoutToken({ sub: 'user-1', jti: 'jti-1', iss: ISSUER });

    expect((await verifyLogoutToken(token, { issuer: `${ISSUER}/`, clientId: CLIENT_ID })).ok).toBe(
      false,
    );
  });
});

describe('rememberLogoutJti', () => {
  it('accepts a jti once and refuses it thereafter', async () => {
    expect(await rememberLogoutJti(ISSUER, 'jti-1')).toBe(true);
    expect(await rememberLogoutJti(ISSUER, 'jti-1')).toBe(false);
  });

  it('scopes the jti to its issuer', async () => {
    expect(await rememberLogoutJti(ISSUER, 'jti-1')).toBe(true);
    expect(await rememberLogoutJti('https://other.example', 'jti-1')).toBe(true);
  });
});
