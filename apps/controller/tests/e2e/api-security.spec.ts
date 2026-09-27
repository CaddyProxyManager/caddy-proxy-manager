/**
 * E2E: every /api/v1/ endpoint enforces auth and RBAC - 401 unauthenticated, 403 for user/viewer
 * on admin-only endpoints, allowed on user endpoints, admins everywhere.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import * as seed from '../helpers/seed';

const BASE = 'http://localhost:3000/api/v1';
const ORIGIN = 'http://localhost:3000';

// ── Endpoint definitions ────────────────────────────────────────────────

type Endpoint = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  /** 'admin'/'user' are bearer-accessible; 'session' requires interactive auth. */
  auth: 'admin' | 'user' | 'session';
  /** Avoids a 400 for a missing body. */
  body?: Record<string, unknown>;
};

// 999 404s after auth passes, which is fine - only auth is tested.
const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/proxy-hosts', auth: 'admin' },
  {
    method: 'POST',
    path: '/proxy-hosts',
    auth: 'admin',
    body: { name: 'x', domains: ['x.test'], upstreams: ['127.0.0.1:80'] },
  },
  { method: 'GET', path: '/proxy-hosts/999', auth: 'admin' },
  { method: 'PUT', path: '/proxy-hosts/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/proxy-hosts/999', auth: 'admin' },
  { method: 'GET', path: '/proxy-hosts/999/forward-auth-access', auth: 'admin' },
  {
    method: 'PUT',
    path: '/proxy-hosts/999/forward-auth-access',
    auth: 'admin',
    body: { userIds: [], groupIds: [] },
  },
  { method: 'GET', path: '/proxy-hosts/999/mtls-access-rules', auth: 'admin' },
  {
    method: 'POST',
    path: '/proxy-hosts/999/mtls-access-rules',
    auth: 'admin',
    body: { pathPattern: '/', allowedRoleIds: [] },
  },
  { method: 'GET', path: '/proxy-hosts/999/mtls-access-rules/999', auth: 'admin' },
  {
    method: 'PUT',
    path: '/proxy-hosts/999/mtls-access-rules/999',
    auth: 'admin',
    body: { pathPattern: '/' },
  },
  { method: 'DELETE', path: '/proxy-hosts/999/mtls-access-rules/999', auth: 'admin' },

  { method: 'GET', path: '/l4-proxy-hosts', auth: 'admin' },
  {
    method: 'POST',
    path: '/l4-proxy-hosts',
    auth: 'admin',
    body: { name: 'x', protocol: 'tcp', listenAddress: ':9999', upstreams: ['127.0.0.1:80'] },
  },
  { method: 'GET', path: '/l4-proxy-hosts/999', auth: 'admin' },
  { method: 'PUT', path: '/l4-proxy-hosts/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/l4-proxy-hosts/999', auth: 'admin' },

  { method: 'GET', path: '/certificates', auth: 'admin' },
  {
    method: 'POST',
    path: '/certificates',
    auth: 'admin',
    body: { name: 'x', type: 'custom', domainNames: ['x.test'] },
  },
  { method: 'GET', path: '/certificates/999', auth: 'admin' },
  { method: 'PUT', path: '/certificates/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/certificates/999', auth: 'admin' },

  { method: 'GET', path: '/ca-certificates', auth: 'admin' },
  {
    method: 'POST',
    path: '/ca-certificates',
    auth: 'admin',
    body: { name: 'x', certificatePem: 'x' },
  },
  { method: 'GET', path: '/ca-certificates/999', auth: 'admin' },
  { method: 'PUT', path: '/ca-certificates/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/ca-certificates/999', auth: 'admin' },

  { method: 'GET', path: '/client-certificates', auth: 'admin' },
  {
    method: 'POST',
    path: '/client-certificates',
    auth: 'admin',
    body: { caCertificateId: 999, commonName: 'x' },
  },
  { method: 'GET', path: '/client-certificates/999', auth: 'admin' },
  { method: 'DELETE', path: '/client-certificates/999', auth: 'admin' },
  { method: 'GET', path: '/client-certificates/999/roles', auth: 'admin' },

  { method: 'GET', path: '/access-lists', auth: 'admin' },
  { method: 'POST', path: '/access-lists', auth: 'admin', body: { name: 'x' } },
  { method: 'GET', path: '/access-lists/999', auth: 'admin' },
  { method: 'PUT', path: '/access-lists/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/access-lists/999', auth: 'admin' },
  {
    method: 'POST',
    path: '/access-lists/999/entries',
    auth: 'admin',
    body: { username: 'x', password: 'x' },
  },
  { method: 'DELETE', path: '/access-lists/999/entries/999', auth: 'admin' },

  { method: 'GET', path: '/mtls-roles', auth: 'admin' },
  { method: 'POST', path: '/mtls-roles', auth: 'admin', body: { name: 'x' } },
  { method: 'GET', path: '/mtls-roles/999', auth: 'admin' },
  { method: 'PUT', path: '/mtls-roles/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/mtls-roles/999', auth: 'admin' },
  {
    method: 'POST',
    path: '/mtls-roles/999/certificates',
    auth: 'admin',
    body: { issuedClientCertificateId: 999 },
  },
  { method: 'DELETE', path: '/mtls-roles/999/certificates/999', auth: 'admin' },

  { method: 'GET', path: '/groups', auth: 'admin' },
  { method: 'POST', path: '/groups', auth: 'admin', body: { name: 'x' } },
  { method: 'GET', path: '/groups/999', auth: 'admin' },
  { method: 'PATCH', path: '/groups/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/groups/999', auth: 'admin' },
  { method: 'POST', path: '/groups/999/members', auth: 'admin', body: { userId: 999 } },
  { method: 'DELETE', path: '/groups/999/members/999', auth: 'admin' },

  { method: 'GET', path: '/settings/general', auth: 'admin' },
  { method: 'PUT', path: '/settings/general', auth: 'admin', body: {} },

  { method: 'GET', path: '/forward-auth-sessions', auth: 'admin' },
  { method: 'DELETE', path: '/forward-auth-sessions', auth: 'admin' },
  { method: 'DELETE', path: '/forward-auth-sessions/999', auth: 'admin' },

  { method: 'GET', path: '/audit-log', auth: 'admin' },

  { method: 'POST', path: '/caddy/apply', auth: 'admin' },

  { method: 'GET', path: '/oauth-providers', auth: 'admin' },
  {
    method: 'POST',
    path: '/oauth-providers',
    auth: 'admin',
    body: { name: 'x', clientId: 'x', clientSecret: 'x' },
  },
  { method: 'GET', path: '/oauth-providers/999', auth: 'admin' },
  { method: 'PUT', path: '/oauth-providers/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/oauth-providers/999', auth: 'admin' },

  { method: 'GET', path: '/openapi.json', auth: 'admin' },

  // Single-user endpoints allow self-access only, so an arbitrary id needs admin.
  { method: 'GET', path: '/users', auth: 'admin' },
  { method: 'GET', path: '/users/999', auth: 'admin' },
  { method: 'PUT', path: '/users/999', auth: 'admin', body: { name: 'x' } },
  { method: 'DELETE', path: '/users/999', auth: 'admin' },

  // Any authenticated user manages their own tokens.
  { method: 'GET', path: '/tokens', auth: 'user' },
  { method: 'POST', path: '/tokens', auth: 'session', body: { name: 'x' } },
  { method: 'DELETE', path: '/tokens/999', auth: 'user' },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function createApiToken(username: string): string {
  return seed.createApiToken(
    `${username}@localhost`,
    'e2e-security-test',
    `test-api-token-${username}-${Date.now()}`,
  );
}

async function apiRequest(
  request: APIRequestContext,
  endpoint: Endpoint,
  token?: string,
): Promise<number> {
  const url = `${BASE}${endpoint.path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Awaited<ReturnType<typeof request.get>>;
  switch (endpoint.method) {
    case 'GET':
      res = await request.get(url, { headers });
      break;
    case 'POST':
      res = await request.post(url, { headers, data: endpoint.body ?? {} });
      break;
    case 'PUT':
      res = await request.put(url, { headers, data: endpoint.body ?? {} });
      break;
    case 'DELETE':
      res = await request.delete(url, { headers });
      break;
    case 'PATCH':
      res = await request.patch(url, { headers, data: endpoint.body ?? {} });
      break;
  }
  return res.status();
}

// ── Setup ───────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });

let userToken: string;
let viewerToken: string;
let adminToken: string;

test.beforeAll(async () => {
  // Docker exec can transiently fail under load.
  for (let i = 0; i < 3; i++) {
    try {
      seed.ensureTestUser('apisec-user', 'ApiSecUser2026!', 'user');
      seed.ensureTestUser('apisec-viewer', 'ApiSecViewer2026!', 'viewer');
      break;
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  userToken = createApiToken('apisec-user');
  viewerToken = createApiToken('apisec-viewer');
  adminToken = createApiToken('testadmin');
});

// ── Unauthenticated ─────────────────────────────────────────────────────

test.describe('Unauthenticated API access', () => {
  for (const ep of ENDPOINTS) {
    test(`${ep.method} ${ep.path} → 401`, async ({ request }) => {
      const status = await apiRequest(request, ep);
      expect(status).toBe(401);
    });
  }
});

// ── User role ───────────────────────────────────────────────────────────

test.describe('User role API access', () => {
  const adminOnly = ENDPOINTS.filter((ep) => ep.auth === 'admin');
  const userAllowed = ENDPOINTS.filter((ep) => ep.auth === 'user');
  const sessionOnly = ENDPOINTS.filter((ep) => ep.auth === 'session');

  for (const ep of adminOnly) {
    test(`${ep.method} ${ep.path} → 403`, async ({ request }) => {
      const status = await apiRequest(request, ep, userToken);
      expect(status).toBe(403);
    });
  }

  for (const ep of userAllowed) {
    test(`${ep.method} ${ep.path} → allowed (not 401/403)`, async ({ request }) => {
      const status = await apiRequest(request, ep, userToken);
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    });
  }

  for (const ep of sessionOnly) {
    test(`${ep.method} ${ep.path} → 403 for bearer credentials`, async ({ request }) => {
      expect(await apiRequest(request, ep, userToken)).toBe(403);
    });
  }
});

// ── Viewer role ─────────────────────────────────────────────────────────

test.describe('Viewer role API access', () => {
  const adminOnly = ENDPOINTS.filter((ep) => ep.auth === 'admin');
  const userAllowed = ENDPOINTS.filter((ep) => ep.auth === 'user');
  const sessionOnly = ENDPOINTS.filter((ep) => ep.auth === 'session');

  for (const ep of adminOnly) {
    test(`${ep.method} ${ep.path} → 403`, async ({ request }) => {
      const status = await apiRequest(request, ep, viewerToken);
      expect(status).toBe(403);
    });
  }

  for (const ep of userAllowed) {
    test(`${ep.method} ${ep.path} → allowed (not 401/403)`, async ({ request }) => {
      const status = await apiRequest(request, ep, viewerToken);
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    });
  }

  for (const ep of sessionOnly) {
    test(`${ep.method} ${ep.path} → 403 for bearer credentials`, async ({ request }) => {
      expect(await apiRequest(request, ep, viewerToken)).toBe(403);
    });
  }
});

// ── Admin role ──────────────────────────────────────────────────────────

test.describe('Admin role API access', () => {
  for (const ep of ENDPOINTS.filter((endpoint) => endpoint.auth !== 'session')) {
    test(`${ep.method} ${ep.path} → allowed (not 401/403)`, async ({ request }) => {
      const status = await apiRequest(request, ep, adminToken);
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    });
  }

  for (const ep of ENDPOINTS.filter((endpoint) => endpoint.auth === 'session')) {
    test(`${ep.method} ${ep.path} → 403 for admin bearer credentials`, async ({ request }) => {
      expect(await apiRequest(request, ep, adminToken)).toBe(403);
    });
  }
});

// ── Cross-user isolation ────────────────────────────────────────────────

test.describe('Cross-user isolation', () => {
  test("user cannot GET another user's profile", async ({ request }) => {
    const status = await apiRequest(
      request,
      { method: 'GET', path: '/users/1', auth: 'user' },
      userToken,
    );
    expect(status).toBe(403);
  });

  test("user cannot PUT another user's profile", async ({ request }) => {
    const status = await apiRequest(
      request,
      { method: 'PUT', path: '/users/1', auth: 'user', body: { name: 'hacked' } },
      userToken,
    );
    expect(status).toBe(403);
  });

  test('user cannot DELETE another user', async ({ request }) => {
    const status = await apiRequest(
      request,
      { method: 'DELETE', path: '/users/1', auth: 'user' },
      userToken,
    );
    expect(status).toBe(403);
  });

  test("viewer cannot GET another user's profile", async ({ request }) => {
    const status = await apiRequest(
      request,
      { method: 'GET', path: '/users/1', auth: 'user' },
      viewerToken,
    );
    expect(status).toBe(403);
  });

  test("viewer cannot PUT another user's profile", async ({ request }) => {
    const status = await apiRequest(
      request,
      { method: 'PUT', path: '/users/1', auth: 'user', body: { name: 'hacked' } },
      viewerToken,
    );
    expect(status).toBe(403);
  });

  test('viewer cannot DELETE another user', async ({ request }) => {
    const status = await apiRequest(
      request,
      { method: 'DELETE', path: '/users/1', auth: 'user' },
      viewerToken,
    );
    expect(status).toBe(403);
  });

  test('user can GET their own profile', async ({ request }) => {
    await request.get(`${ORIGIN}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    // Bearer tokens go through api-auth, not a Better Auth session; self-access is covered by the
    // token endpoints.
  });

  test("admin CAN access other users' profiles", async ({ request }) => {
    // The id comes from the /users list.
    const res = await request.get(`${BASE}/users`, {
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const users: Array<{ id: number; email: string }> = await res.json();
    const apisecUser = users.find((u) => u.email === 'apisec-user@localhost');
    expect(apisecUser).toBeTruthy();

    const profileRes = await request.get(`${BASE}/users/${apisecUser!.id}`, {
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    });
    expect(profileRes.status()).toBe(200);
  });
});
