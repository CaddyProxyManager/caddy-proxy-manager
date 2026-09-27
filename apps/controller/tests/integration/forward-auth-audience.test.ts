/**
 * CPM-API-001: a code disclosed to another subdomain, scheme or port must not be redeemable there,
 * and a token for one origin must never become a global bearer credential.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { NextRequest } from 'next/server';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// A non-default port must be declared; these tests use two. Read per call, from the environment
// until a value is stored.
process.env.FORWARD_AUTH_ALLOWED_PORTS = '8443, 9443';

// bun evaluates a vi.mock factory synchronously while linking, so the helpers it needs
// are imported above it rather than awaited inside it.
const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    sqlite: undefined,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (value: string | Date | null | undefined): string | null => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    },
  };
});

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

// The real builder keeps the proof-header wiring covered; only the apply is stubbed. bun has no
// importOriginal, so the module is imported before the mock replaces it.
const actualCaddy = await import('../../src/lib/caddy');

vi.mock('../../src/lib/caddy', () => ({
  ...actualCaddy,
  applyCaddyConfig: vi.fn().mockResolvedValue(undefined),
}));

import * as schema from '../../src/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  createExchangeCode,
  createForwardAuthSession,
  createRedirectIntent,
  getDisallowedForwardAuthPort,
  redeemExchangeCode,
  resolveForwardAuthAudience,
  validateForwardAuthSession,
} from '../../src/lib/models/forward-auth';
import { GET as forwardAuthCallback } from '../../src/app/api/forward-auth/callback/route';
import { GET as forwardAuthVerify } from '../../src/app/api/forward-auth/verify/route';
import {
  FORWARD_AUTH_PORTAL_TARGET_HEADER,
  FORWARD_AUTH_PROXY_HOST_ID_HEADER,
  FORWARD_AUTH_PROXY_PROOF_HEADER,
  getForwardAuthProxyProof,
  getTrustedForwardAuthOrigin,
} from '../../src/lib/forward-auth-trust';
import { buildCaddyDocument } from '../../src/lib/caddy';

const now = () => new Date().toISOString();

async function insertUser() {
  const timestamp = now();
  const [user] = await ctx.db
    .insert(schema.users)
    .values({
      email: 'alice@localhost',
      name: 'Alice',
      role: 'user',
      provider: 'credentials',
      subject: 'alice',
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  return user;
}

async function insertWildcardHost() {
  const timestamp = now();
  const [host] = await ctx.db
    .insert(schema.proxyHosts)
    .values({
      name: 'Wildcard apps',
      domains: JSON.stringify(['*.example.com']),
      upstreams: JSON.stringify(['backend:8080']),
      sslForced: true,
      hstsEnabled: true,
      hstsSubdomains: false,
      allowWebsocket: true,
      preserveHostHeader: true,
      skipHttpsHostnameValidation: false,
      enabled: true,
      meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  return host;
}

async function setupAuthorizedWildcard() {
  const user = await insertUser();
  const host = await insertWildcardHost();
  await ctx.db.insert(schema.forwardAuthAccess).values({
    proxyHostId: host.id,
    userId: user.id,
    groupId: null,
    createdAt: now(),
  });
  return { user, host };
}

function proxyHeaders(
  origin: string,
  proof = getForwardAuthProxyProof(),
  proxyHostId?: number,
): Record<string, string> {
  const target = new URL(origin);
  return {
    'x-forwarded-proto': target.protocol.slice(0, -1),
    'x-forwarded-host': target.host,
    [FORWARD_AUTH_PROXY_PROOF_HEADER]: proof,
    ...(proxyHostId !== undefined
      ? { [FORWARD_AUTH_PROXY_HOST_ID_HEADER]: String(proxyHostId) }
      : {}),
  };
}

function rawProxyHeaders(proto: string, rawHost: string): Record<string, string> {
  return {
    'x-forwarded-proto': proto,
    'x-forwarded-host': rawHost,
    [FORWARD_AUTH_PROXY_PROOF_HEADER]: getForwardAuthProxyProof(),
  };
}

async function insertExactHost(domain: string) {
  const timestamp = now();
  const [host] = await ctx.db
    .insert(schema.proxyHosts)
    .values({
      name: `Exact ${domain}`,
      domains: JSON.stringify([domain]),
      upstreams: JSON.stringify(['backend2:8080']),
      sslForced: true,
      hstsEnabled: true,
      hstsSubdomains: false,
      allowWebsocket: true,
      preserveHostHeader: true,
      skipHttpsHostnameValidation: false,
      enabled: true,
      meta: JSON.stringify({ cpm_forward_auth: { enabled: true } }),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  return host;
}

async function createCode(userId: number, target: string) {
  const rid = await createRedirectIntent(target);
  const intent = await (await import('../../src/lib/models/forward-auth')).consumeRedirectIntent(
    rid,
  );
  if (!intent) throw new Error('test redirect intent was not created');
  const { session } = await createForwardAuthSession(userId, intent.audience);
  const { rawCode } = await createExchangeCode(session.id, intent.redirectUri, intent.audience);
  return { rawCode, audience: intent.audience };
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users);
});

describe('forward-auth exact audience binding', () => {
  it('persists the concrete wildcard origin and proxy host in every credential stage', async () => {
    const { user, host } = await setupAuthorizedWildcard();
    const target = 'https://private.example.com:8443/deep/path?x=1';

    const rid = await createRedirectIntent(target);
    const [storedIntent] = await ctx.db.select().from(schema.forwardAuthRedirectIntents);
    expect(storedIntent).toMatchObject({
      proxyHostId: host.id,
      audienceOrigin: 'https://private.example.com:8443',
      redirectUri: target,
    });

    const { consumeRedirectIntent } = await import('../../src/lib/models/forward-auth');
    const intent = await consumeRedirectIntent(rid);
    expect(intent?.audience).toEqual({
      proxyHostId: host.id,
      origin: 'https://private.example.com:8443',
      hostname: 'private.example.com',
    });

    const { rawToken, session } = await createForwardAuthSession(user.id, intent!.audience);
    expect(session).toMatchObject({
      proxyHostId: host.id,
      audienceOrigin: 'https://private.example.com:8443',
    });
    await expect(validateForwardAuthSession(rawToken, intent!.audience)).resolves.toEqual({
      sessionId: session.id,
      userId: user.id,
    });

    await createExchangeCode(session.id, target, intent!.audience);
    const [exchange] = await ctx.db.select().from(schema.forwardAuthExchanges);
    expect(exchange).toMatchObject({
      proxyHostId: host.id,
      audienceOrigin: 'https://private.example.com:8443',
    });
  });

  it.each([
    ['another wildcard hostname', 'https://evil.example.com'],
    ['another port', 'https://private.example.com:9443'],
    ['another scheme', 'http://private.example.com:8443'],
  ])('does not consume a code at %s', async (_caseName, wrongOrigin) => {
    const { user } = await setupAuthorizedWildcard();
    const target = 'https://private.example.com:8443/account';
    const { rawCode, audience } = await createCode(user.id, target);
    const wrongAudience = await resolveForwardAuthAudience(wrongOrigin);
    expect(wrongAudience).not.toBeNull();

    await expect(redeemExchangeCode(rawCode, wrongAudience!)).resolves.toBeNull();
    const [stillValid] = await ctx.db.select().from(schema.forwardAuthExchanges);
    expect(stillValid.used).toBe(false);

    const redeemed = await redeemExchangeCode(rawCode, audience);
    expect(redeemed?.redirectUri).toBe(target);
  });

  it('scopes the resulting session token to the exact origin', async () => {
    const { user } = await setupAuthorizedWildcard();
    const target = 'https://private.example.com/profile';
    const { rawCode, audience } = await createCode(user.id, target);
    const redeemed = await redeemExchangeCode(rawCode, audience);
    expect(redeemed).not.toBeNull();

    const siblingAudience = await resolveForwardAuthAudience('https://other.example.com');
    await expect(
      validateForwardAuthSession(redeemed!.rawSessionToken, siblingAudience!),
    ).resolves.toBeNull();
    await expect(validateForwardAuthSession(redeemed!.rawSessionToken, audience)).resolves.toEqual({
      sessionId: redeemed!.sessionId,
      userId: user.id,
    });
  });
});

describe('trusted Caddy callback boundary', () => {
  it('rejects direct-origin requests even when forwarded host/protocol are forged', async () => {
    const { user } = await setupAuthorizedWildcard();
    const { rawCode } = await createCode(user.id, 'https://private.example.com/');

    const directRequest = new NextRequest(
      `http://localhost:3000/api/forward-auth/callback?code=${rawCode}`,
      {
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'private.example.com',
        },
      },
    );
    const response = await forwardAuthCallback(directRequest);
    expect(response.status).toBe(401);

    const [exchange] = await ctx.db.select().from(schema.forwardAuthExchanges);
    expect(exchange.used).toBe(false);
  });

  it('rejects a disclosed code at a different Caddy-served wildcard origin without consuming it', async () => {
    const { user, host } = await setupAuthorizedWildcard();
    const target = 'https://private.example.com/dashboard';
    const { rawCode } = await createCode(user.id, target);

    const attackerRequest = new NextRequest(
      `http://localhost/api/forward-auth/callback?code=${rawCode}`,
      {
        headers: proxyHeaders('https://evil.example.com', undefined, host.id),
      },
    );
    expect((await forwardAuthCallback(attackerRequest)).status).toBe(401);

    const legitimateRequest = new NextRequest(
      `http://localhost/api/forward-auth/callback?code=${rawCode}`,
      {
        headers: proxyHeaders('https://private.example.com', undefined, host.id),
      },
    );
    const response = await forwardAuthCallback(legitimateRequest);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(target);
    expect(response.headers.get('set-cookie')).toContain('_cpm_fa=');
  });

  it('rejects malformed or forged proxy proofs using a timing-safe fixed-length check', () => {
    expect(
      getTrustedForwardAuthOrigin(
        new Headers(proxyHeaders('https://private.example.com', '0'.repeat(64))),
      ),
    ).toBeNull();
    expect(
      getTrustedForwardAuthOrigin(
        new Headers(proxyHeaders('https://private.example.com', 'short')),
      ),
    ).toBeNull();
    expect(
      getTrustedForwardAuthOrigin(new Headers(proxyHeaders('https://private.example.com:8443'))),
    ).toBe('https://private.example.com:8443');
  });

  it('injects the proof into both generated Caddy subrequests', async () => {
    await setupAuthorizedWildcard();
    const document = await buildCaddyDocument();
    const reverseProxies: Array<Record<string, unknown>> = [];

    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (object.handler === 'reverse_proxy') reverseProxies.push(object);
        Object.values(object).forEach(visit);
      }
    };
    visit(document);

    const securityRoutes = reverseProxies.filter((proxy) => {
      const uri = (proxy.rewrite as { uri?: string } | undefined)?.uri ?? '';
      return uri.includes('/api/forward-auth/verify') || uri.includes('/api/forward-auth/callback');
    });
    expect(securityRoutes.length).toBeGreaterThanOrEqual(2);
    for (const proxy of securityRoutes) {
      const set = (proxy.headers as { request?: { set?: Record<string, string[]> } } | undefined)
        ?.request?.set;
      expect(set?.[FORWARD_AUTH_PROXY_PROOF_HEADER]).toEqual([getForwardAuthProxyProof()]);
      expect(set?.['X-Forwarded-Host']).toEqual(['{http.request.hostport}']);
    }

    // Caddy's `host` omits the port; `hostport` keeps a :8443 origin intact.
    const serialized = JSON.stringify(document);
    expect(serialized).toContain('://{http.request.hostport}{http.request.uri_escaped}');
    // The raw request URI is never placed in the portal query string.
    expect(serialized).not.toContain('{http.request.hostport}{http.request.uri}"');
  });
});

describe('forwarded host must match the route Caddy chose', () => {
  it.each([
    ['percent-encoded label', '%61pp.example.com'],
    ['percent-encoded dot', 'x%2eapp.example.com'],
    ['percent-encoded UTF-8', '%EF%BD%81pp.example.com'],
    ['IPv4 shorthand', '127.1'],
    ['multiple values', 'app.example.com, evil.example.com'],
  ])('rejects a %s', (_caseName, rawHost) => {
    expect(getTrustedForwardAuthOrigin(new Headers(rawProxyHeaders('https', rawHost)))).toBeNull();
  });

  it('accepts a plain hostname regardless of case', () => {
    expect(
      getTrustedForwardAuthOrigin(new Headers(rawProxyHeaders('https', 'App.Example.com'))),
    ).toBe('https://app.example.com');
  });

  it('refuses a callback whose origin resolves to a different proxy host than the pinned route', async () => {
    const { user, host: wildcard } = await setupAuthorizedWildcard();
    const exact = await insertExactHost('app.example.com');
    await ctx.db.insert(schema.forwardAuthAccess).values({
      proxyHostId: exact.id,
      userId: user.id,
      groupId: null,
      createdAt: now(),
    });
    const { rawCode } = await createCode(user.id, 'https://app.example.com/');
    const callback = (headers: Record<string, string>) =>
      forwardAuthCallback(
        new NextRequest(`http://localhost/api/forward-auth/callback?code=${rawCode}`, { headers }),
      );

    // Routed through the wildcard host's Caddy route, but claiming the exact host.
    expect(
      (await callback(proxyHeaders('https://app.example.com', undefined, wildcard.id))).status,
    ).toBe(401);
    expect((await callback(proxyHeaders('https://app.example.com'))).status).toBe(401);

    const [exchange] = await ctx.db.select().from(schema.forwardAuthExchanges);
    expect(exchange.used).toBe(false);

    expect(
      (await callback(proxyHeaders('https://app.example.com', undefined, exact.id))).status,
    ).toBe(302);
  });

  it('pins each generated subrequest to its own proxy host id', async () => {
    const { host } = await setupAuthorizedWildcard();
    const serialized = JSON.stringify(await buildCaddyDocument());
    expect(serialized).toContain(`"${FORWARD_AUTH_PROXY_HOST_ID_HEADER}":["${host.id}"]`);
  });
});

describe('verify endpoint portal target', () => {
  function verifyRequest(headers: Record<string, string>) {
    return new NextRequest('http://localhost/api/forward-auth/verify', { headers });
  }

  it('returns the protected URL encoded so its query string survives the portal round trip', async () => {
    const { host } = await setupAuthorizedWildcard();
    const uri = '/search?q=a%26b&page=2&tag=c++&rd=https://evil.test/&rid=abc#frag';
    const response = await forwardAuthVerify(
      verifyRequest({
        ...proxyHeaders('https://private.example.com', undefined, host.id),
        'x-forwarded-uri': uri,
      }),
    );

    expect(response.status).toBe(401);
    const target = response.headers.get(FORWARD_AUTH_PORTAL_TARGET_HEADER);
    expect(target).toBeTruthy();
    expect(target).not.toMatch(/[&#+ ]/);
    expect(target).toContain('https://private.example.com/search?q=');

    // Parsed exactly as the portal's query string is.
    const params = new URLSearchParams(`rd=${target}`);
    expect(params.getAll('rd')).toEqual([`https://private.example.com${uri}`]);
    expect(params.has('rid')).toBe(false);
  });

  it('sends the target on 403 as well', async () => {
    const { user, host } = await setupAuthorizedWildcard();
    await ctx.db.delete(schema.forwardAuthAccess);
    const { rawCode, audience } = await createCode(user.id, 'https://private.example.com/');
    const redeemed = await redeemExchangeCode(rawCode, audience);
    const forbidden = await forwardAuthVerify(
      verifyRequest({
        ...proxyHeaders('https://private.example.com', undefined, host.id),
        'x-forwarded-uri': '/admin',
        cookie: `_cpm_fa=${redeemed!.rawSessionToken}`,
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get(FORWARD_AUTH_PORTAL_TARGET_HEADER)).toBe(
      'https://private.example.com/admin',
    );
  });

  it('sends no target without the proxy proof or for a non origin-form URI', async () => {
    const { host } = await setupAuthorizedWildcard();
    const direct = await forwardAuthVerify(
      verifyRequest({
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'private.example.com',
        'x-forwarded-uri': '/',
      }),
    );
    expect(direct.status).toBe(401);
    expect(direct.headers.get(FORWARD_AUTH_PORTAL_TARGET_HEADER)).toBeNull();

    for (const uri of ['*', 'https://evil.test/', '']) {
      const response = await forwardAuthVerify(
        verifyRequest({
          ...proxyHeaders('https://private.example.com', undefined, host.id),
          'x-forwarded-uri': uri,
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get(FORWARD_AUTH_PORTAL_TARGET_HEADER)).toBeNull();
    }
  });

  it('names the user by sign-in username or email, never by the display name others can share', async () => {
    const { user, host } = await setupAuthorizedWildcard();
    const verifiedHeaders = async () => {
      const { rawCode, audience } = await createCode(user.id, 'https://private.example.com/');
      const redeemed = await redeemExchangeCode(rawCode, audience);
      const response = await forwardAuthVerify(
        verifyRequest({
          ...proxyHeaders('https://private.example.com', undefined, host.id),
          'x-forwarded-uri': '/',
          cookie: `_cpm_fa=${redeemed!.rawSessionToken}`,
        }),
      );
      expect(response.status).toBe(200);
      return response.headers;
    };

    // Display name "admin", as anyone can pick; no username: the email address.
    await ctx.db.update(schema.users).set({ name: 'admin' }).where(eq(schema.users.id, user.id));
    let headers = await verifiedHeaders();
    expect(headers.get('X-CPM-User')).toBe('alice@localhost');
    expect(headers.get('X-CPM-User-Id')).toBe(String(user.id));

    await ctx.db
      .update(schema.users)
      .set({ username: 'alice' })
      .where(eq(schema.users.id, user.id));
    headers = await verifiedHeaders();
    expect(headers.get('X-CPM-User')).toBe('alice');
    expect(headers.get('X-CPM-Email')).toBe('alice@localhost');
  });
});

describe('non-default forward-auth ports', () => {
  it('rejects redirect targets on undeclared ports', async () => {
    await setupAuthorizedWildcard();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        resolveForwardAuthAudience('https://private.example.com:9999'),
      ).resolves.toBeNull();
      await expect(createRedirectIntent('https://private.example.com:9999/')).rejects.toThrow();
      await expect(
        resolveForwardAuthAudience('https://private.example.com:8443'),
      ).resolves.not.toBeNull();
      await expect(
        resolveForwardAuthAudience('https://private.example.com:443'),
      ).resolves.not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('takes the list from the stored setting once there is one', async () => {
    await setupAuthorizedWildcard();
    const { forwardAuthAllowedPorts } = await import('../../src/lib/settings/registry');
    const { clearStoredSetting, saveSettings } = await import('../../src/lib/settings/resolve');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await saveSettings({ [forwardAuthAllowedPorts.key]: '7443' });
    try {
      await expect(
        resolveForwardAuthAudience('https://private.example.com:7443'),
      ).resolves.not.toBeNull();
      await expect(
        resolveForwardAuthAudience('https://private.example.com:8443'),
      ).resolves.toBeNull();
    } finally {
      await clearStoredSetting(forwardAuthAllowedPorts.key);
      warn.mockRestore();
    }
  });
});

describe('undeclared forward-auth ports are reported', () => {
  it('warns once per port, naming the setting, only for forward-auth hosts', async () => {
    await setupAuthorizedWildcard();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        resolveForwardAuthAudience('https://private.example.com:7001/'),
      ).resolves.toBeNull();
      await expect(createRedirectIntent('https://private.example.com:7001/x')).rejects.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('FORWARD_AUTH_ALLOWED_PORTS');
      expect(String(warn.mock.calls[0][0])).toContain('7001');

      await resolveForwardAuthAudience('https://other.example.com:7002/');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1][0])).toContain('7002');

      // Not a forward-auth host, a declared port, or a default port: silent.
      await resolveForwardAuthAudience('https://unrelated.test:7003/');
      await resolveForwardAuthAudience('https://private.example.com:8443/');
      await resolveForwardAuthAudience('https://private.example.com:443/');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports a port again in the next hour, even after probing filled the cap', async () => {
    await setupAuthorizedWildcard();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Far from any earlier test's window, so this one starts empty.
    const start = Date.UTC(2099, 0, 1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      for (let port = 7100; port < 7132; port++) {
        await resolveForwardAuthAudience(`https://private.example.com:${port}/`);
      }
      expect(warn).toHaveBeenCalledTimes(32);
      await resolveForwardAuthAudience('https://private.example.com:7200/');
      expect(warn).toHaveBeenCalledTimes(32);

      clock.mockReturnValue(start + 60 * 60_000 - 1_000);
      await resolveForwardAuthAudience('https://private.example.com:7200/');
      expect(warn).toHaveBeenCalledTimes(32);

      clock.mockReturnValue(start + 60 * 60_000);
      await resolveForwardAuthAudience('https://private.example.com:7200/');
      expect(warn).toHaveBeenCalledTimes(33);
      expect(String(warn.mock.calls[32][0])).toContain('port 7200');
      await resolveForwardAuthAudience('https://private.example.com:7100/');
      expect(warn).toHaveBeenCalledTimes(34);
    } finally {
      clock.mockRestore();
      warn.mockRestore();
    }
  });

  it('identifies a forward-auth URL rejected only because of its port', async () => {
    await setupAuthorizedWildcard();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        getDisallowedForwardAuthPort('https://private.example.com:7004/app?x=1'),
      ).resolves.toBe('7004');
      await expect(
        getDisallowedForwardAuthPort('https://private.example.com:8443/'),
      ).resolves.toBeNull();
      await expect(
        getDisallowedForwardAuthPort('https://private.example.com/'),
      ).resolves.toBeNull();
      await expect(
        getDisallowedForwardAuthPort('https://unrelated.test:7004/'),
      ).resolves.toBeNull();
      await expect(getDisallowedForwardAuthPort('javascript:alert(1)')).resolves.toBeNull();
      await expect(
        getDisallowedForwardAuthPort('https://user:pw@private.example.com:7004/'),
      ).resolves.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('sends verify the portal target for an undeclared port, so the portal can explain it', async () => {
    const { host } = await setupAuthorizedWildcard();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await forwardAuthVerify(
        new NextRequest('http://localhost/api/forward-auth/verify', {
          headers: {
            ...proxyHeaders('https://private.example.com:7005', undefined, host.id),
            'x-forwarded-uri': '/',
          },
        }),
      );
      expect(response.status).toBe(401);
      const target = response.headers.get(FORWARD_AUTH_PORTAL_TARGET_HEADER);
      expect(new URLSearchParams(`rd=${target}`).get('rd')).toBe(
        'https://private.example.com:7005/',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
