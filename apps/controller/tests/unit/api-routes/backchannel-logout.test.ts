/**
 * The one route that deletes sessions on an unauthenticated POST. The refusal's shape matters: an
 * IdP retries a 5xx, gives up on a 400, and `error_description` is all an operator can debug with.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { NextRequest } from 'next/server';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { vi } from '@/tests/helpers/vi';
import { POST, GET } from '@/src/app/api/auth/oidc/backchannel-logout/route';
import * as providerModel from '@/src/lib/models/oauth-providers';
import * as logoutService from '@/src/lib/services/oidc-logout';
import { clearDiscoveryCache } from '@/src/lib/auth/oidc/claims';
import { clearJwksCache } from '@/src/lib/auth/oidc/logout-token';
import { createTestDb } from '@/tests/helpers/db';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { spentNonces } from '@/src/lib/db/schema';

// Spent values are shared by every replica, so they live in the database.
const testDb = await createTestDb();
vi.mock('@/src/lib/db', () => dbModuleMock(() => testDb));

/**
 * A spy, not `vi.mock`: Bun's module mocks leak into every later file in the process, which broke
 * oidc-backchannel-logout.test.ts in single-process runs. `restoreAllMocks` undoes a spy.
 */
let listProviders: ReturnType<typeof vi.spyOn<typeof providerModel, 'listEnabledOAuthProviders'>>;
let revoke: ReturnType<typeof vi.spyOn<typeof logoutService, 'revokeSessionsForLogoutToken'>>;

const ISSUER = 'https://idp.example';
const CLIENT_ID = 'cpm';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function serveIdp(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('.well-known/openid-configuration')) {
      return jsonResponse({ jwks_uri: `${ISSUER}/jwks` });
    }
    if (url.includes('/jwks')) return jsonResponse({ keys: [jwk] });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

let jtiCounter = 0;

async function signLogoutToken(claims: Record<string, unknown> = {}): Promise<string> {
  jtiCounter += 1;
  const { iss = ISSUER, aud = CLIENT_ID, ...rest } = claims as Record<string, string>;
  return new SignJWT({ events: { [LOGOUT_EVENT]: {} }, jti: `jti-${jtiCounter}`, ...rest })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(privateKey);
}

/** The spec posts a form; the handler reads nothing a plain Request lacks. */
function postForm(
  token: string | null,
  contentType = 'application/x-www-form-urlencoded',
): NextRequest {
  const body = new URLSearchParams();
  if (token !== null) body.set('logout_token', token);
  return new Request('https://cpm.example/api/auth/oidc/backchannel-logout', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: body.toString(),
  }) as unknown as NextRequest;
}

const provider = {
  id: 'authentik',
  name: 'Authentik',
  issuer: ISSUER,
  clientId: CLIENT_ID,
};

beforeEach(async () => {
  clearDiscoveryCache();
  clearJwksCache();
  await testDb.delete(spentNonces);
  serveIdp();
  listProviders = vi
    .spyOn(providerModel, 'listEnabledOAuthProviders')
    .mockResolvedValue([provider] as never);
  revoke = vi
    .spyOn(logoutService, 'revokeSessionsForLogoutToken')
    .mockResolvedValue({ sessions: 1, userIds: [7] });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('POST /api/auth/oidc/backchannel-logout', () => {
  it('accepts a valid token and revokes what it names', async () => {
    const response = await POST(postForm(await signLogoutToken({ sub: 'u-1', sid: 'idp-1' })));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(revoke).toHaveBeenCalledWith({
      providerId: 'authentik',
      subject: 'u-1',
      sessionId: 'idp-1',
    });
  });

  it('answers 200 when the subject had no sessions here', async () => {
    revoke.mockResolvedValueOnce({ sessions: 0, userIds: [] });

    // Reporting "nothing to do" as a failure would have the IdP retry forever.
    expect((await POST(postForm(await signLogoutToken({ sub: 'u-1' })))).status).toBe(200);
  });

  it('answers a replayed token 200 without revoking twice', async () => {
    const token = await signLogoutToken({ sub: 'u-1' });

    expect((await POST(postForm(token))).status).toBe(200);
    expect((await POST(postForm(token))).status).toBe(200);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that is not a form', async () => {
    const response = await POST(
      postForm(await signLogoutToken({ sub: 'u-1' }), 'application/json'),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_request');
  });

  it('refuses a request with no logout_token', async () => {
    const response = await POST(postForm(null));

    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toContain('logout_token');
  });

  it('refuses a logout_token that is not a JWT', async () => {
    const response = await POST(postForm('not-a-jwt'));

    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toContain('iss');
  });

  it('refuses an issuer no configured provider claims', async () => {
    const response = await POST(
      postForm(await signLogoutToken({ sub: 'u-1', iss: 'https://who.example' })),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toContain('no enabled provider');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('refuses a token whose audience is another client of the same issuer', async () => {
    const response = await POST(
      postForm(await signLogoutToken({ sub: 'u-1', aud: 'other-client' })),
    );

    expect(response.status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('selects a provider by its exact issuer, trailing slash included', async () => {
    const slashed = `${ISSUER}/`;
    listProviders.mockResolvedValue([{ ...provider, issuer: slashed }] as never);

    const response = await POST(postForm(await signLogoutToken({ sub: 'u-1', iss: slashed })));

    expect(response.status).toBe(200);
  });

  it('refuses an issuer that differs from the configured one only by a trailing slash', async () => {
    // Lenient matching would surface a JOSE error instead of the mistyped issuer.
    const response = await POST(postForm(await signLogoutToken({ sub: 'u-1', iss: `${ISSUER}/` })));

    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toContain('no enabled provider');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('tries every provider sharing an issuer before giving up', async () => {
    // Two client registrations against one realm: the token is only valid for the second.
    listProviders.mockResolvedValue([
      { ...provider, id: 'first', clientId: 'another-client' },
      { ...provider, id: 'second' },
    ] as never);

    const response = await POST(postForm(await signLogoutToken({ sub: 'u-1' })));

    expect(response.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'second' }));
  });

  it('reports the failing check rather than a bare invalid_request', async () => {
    const response = await POST(postForm(await signLogoutToken({ sub: 'u-1', nonce: 'n-1' })));

    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toContain('nonce');
  });
});

describe('GET /api/auth/oidc/backchannel-logout', () => {
  it('says the endpoint is POST-only rather than 404ing', async () => {
    const response = await GET();

    expect(response.status).toBe(405);
    expect((await response.json()).error_description).toContain('POST');
  });
});
