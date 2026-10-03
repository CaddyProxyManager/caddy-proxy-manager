/**
 * Regression (SECURITY-AUDIT H1): forward-auth hosts must STRIP client-supplied X-CPM-* headers on
 * EVERY proxying route. Otherwise unprotected and excluded paths pass forged headers through, and
 * authenticated routes only overwrite when the verify value is non-empty.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import * as schema from '../../src/lib/db/schema';

const CPM_HEADERS = ['X-CPM-User', 'X-CPM-Email', 'X-CPM-Groups', 'X-CPM-User-Id'];
const UPSTREAM = '10.0.0.5:8080';

function collectHandleArrays(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) {
    for (const item of node) collectHandleArrays(item, out);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.handle)) out.push(obj.handle as unknown[]);
    for (const v of Object.values(obj)) collectHandleArrays(v, out);
  }
  return out;
}

function isUpstreamProxy(h: unknown): boolean {
  const handler = h as Record<string, unknown>;
  if (handler?.handler !== 'reverse_proxy') return false;
  const ups = (handler.upstreams as Array<{ dial?: string }> | undefined) ?? [];
  return ups.some((u) => u.dial === UPSTREAM);
}

function isCpmStrip(h: unknown): boolean {
  const handler = h as Record<string, unknown>;
  if (handler?.handler !== 'headers') return false;
  const del = (handler.request as { delete?: string[] } | undefined)?.delete;
  if (!Array.isArray(del)) return false;
  // Case-insensitive: Caddy's delete canonicalises through Go's Header.Del, so the spelling may
  // change (it did - see caddy-forward-auth-copy-headers.test.ts).
  const lowered = del.map((name) => name.toLowerCase());
  return CPM_HEADERS.every((name) => lowered.includes(name.toLowerCase()));
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('CPM forward-auth inbound X-CPM-* header stripping', () => {
  it('strips X-CPM-* before the upstream on a full-site protected host', async () => {
    await createProxyHost(
      {
        name: 'fa-fullsite',
        domains: ['app.example.com'],
        upstreams: [UPSTREAM],
        cpmForwardAuth: { enabled: true },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const handleArrays = collectHandleArrays(doc);
    const upstreamRoutes = handleArrays.filter((arr) => arr.some(isUpstreamProxy));

    expect(upstreamRoutes.length).toBeGreaterThan(0);
    for (const arr of upstreamRoutes) {
      const stripIdx = arr.findIndex(isCpmStrip);
      const proxyIdx = arr.findIndex(isUpstreamProxy);
      expect(stripIdx).toBeGreaterThanOrEqual(0); // strip handler present
      expect(stripIdx).toBeLessThan(proxyIdx); // ...and before the upstream proxy
    }
  });

  it('strips X-CPM-* on UNPROTECTED excluded paths (no verify runs there)', async () => {
    await createProxyHost(
      {
        name: 'fa-excluded',
        domains: ['app2.example.com'],
        upstreams: [UPSTREAM],
        cpmForwardAuth: { enabled: true, excluded_paths: ['/public/*'] },
      },
      1,
    );

    const doc = await buildCaddyDocument();
    const handleArrays = collectHandleArrays(doc);

    // No forward-auth subrequest here, yet it must still strip.
    const excludedRoute = handleArrays.find(
      (arr) =>
        arr.some(isUpstreamProxy) &&
        !arr.some(
          (h) =>
            (h as Record<string, unknown>)?.handler === 'reverse_proxy' &&
            JSON.stringify(h).includes('/api/forward-auth/verify'),
        ),
    );

    expect(excludedRoute).toBeDefined();
    expect(excludedRoute!.some(isCpmStrip)).toBe(true);
  });

  it('does not leak X-CPM-* stripping into a plain (non-forward-auth) host', async () => {
    await createProxyHost(
      { name: 'plain', domains: ['plain.example.com'], upstreams: [UPSTREAM] },
      1,
    );

    const doc = await buildCaddyDocument();
    const handleArrays = collectHandleArrays(doc);
    const upstreamRoutes = handleArrays.filter((arr) => arr.some(isUpstreamProxy));

    expect(upstreamRoutes.length).toBeGreaterThan(0);
    // Plain hosts never deal in X-CPM-* headers, so no strip handler is emitted.
    for (const arr of upstreamRoutes) {
      expect(arr.some(isCpmStrip)).toBe(false);
    }
  });
});

const AUTHENTIK_HEADERS = ['X-Authentik-Username', 'X-Authentik-Groups', 'X-Authentik-Email'];

const lower = (names: string[]) => names.map((name) => name.toLowerCase());

function isAuthentikStrip(h: unknown): boolean {
  const handler = h as Record<string, unknown>;
  if (handler?.handler !== 'headers') return false;
  const del = (handler.request as { delete?: string[] } | undefined)?.delete;
  if (!Array.isArray(del)) return false;
  return lower(AUTHENTIK_HEADERS).every((name) => lower(del).includes(name));
}

function expectStripBeforeEveryUpstream(doc: unknown) {
  const upstreamRoutes = collectHandleArrays(doc).filter((arr) => arr.some(isUpstreamProxy));
  expect(upstreamRoutes.length).toBeGreaterThan(0);
  for (const arr of upstreamRoutes) {
    const stripIdx = arr.findIndex(isAuthentikStrip);
    const proxyIdx = arr.findIndex(isUpstreamProxy);
    expect(stripIdx).toBeGreaterThanOrEqual(0);
    expect(stripIdx).toBeLessThan(proxyIdx);
  }
  return upstreamRoutes;
}

const authentikBase = {
  enabled: true,
  outpostDomain: 'outpost.goauthentik.io',
  outpostUpstream: 'http://authentik-server:9000',
  copyHeaders: AUTHENTIK_HEADERS,
};

describe('Authentik forward-auth inbound identity header stripping', () => {
  it('strips copy headers before the upstream on a full-site protected host', async () => {
    await createProxyHost(
      {
        name: 'ak-fullsite',
        domains: ['ak.example.com'],
        upstreams: [UPSTREAM],
        authentik: authentikBase,
        locationRules: [{ path: '/api/*', upstreams: [UPSTREAM] }],
      },
      1,
    );
    expectStripBeforeEveryUpstream(await buildCaddyDocument());
  });

  it('strips copy headers on excluded (unauthenticated) paths', async () => {
    await createProxyHost(
      {
        name: 'ak-excluded',
        domains: ['ak2.example.com'],
        upstreams: [UPSTREAM],
        authentik: { ...authentikBase, excludedPaths: ['/public/*'] },
      },
      1,
    );
    const routes = expectStripBeforeEveryUpstream(await buildCaddyDocument());
    expect(
      routes.some((arr) => !arr.some((h) => JSON.stringify(h).includes('authentik-server:9000'))),
    ).toBe(true);
  });

  it('strips copy headers on the unprotected catch-all and location routes in protected-paths mode', async () => {
    await createProxyHost(
      {
        name: 'ak-protected',
        domains: ['ak3.example.com'],
        upstreams: [UPSTREAM],
        authentik: { ...authentikBase, protectedPaths: ['/admin/*'] },
        locationRules: [{ path: '/api/*', upstreams: [UPSTREAM] }],
      },
      1,
    );
    expectStripBeforeEveryUpstream(await buildCaddyDocument());
  });

  it('drops copy header names that are not valid header tokens', async () => {
    await createProxyHost(
      {
        name: 'ak-badname',
        domains: ['ak4.example.com'],
        upstreams: [UPSTREAM],
        authentik: { ...authentikBase, copyHeaders: [...AUTHENTIK_HEADERS, 'X-Bad}{Name'] },
      },
      1,
    );
    const json = JSON.stringify(await buildCaddyDocument());
    expect(json).not.toContain('X-Bad}{Name');
  });
});

// ── Credential headers, separator spellings ─────────────────────────────

type Handler = Record<string, unknown>;

/** Every `delete` list of a `headers` handler that runs before the upstream proxy. */
function stripListsBeforeUpstream(doc: unknown): string[][] {
  const lists: string[][] = [];
  for (const arr of collectHandleArrays(doc)) {
    const proxyIdx = arr.findIndex(isUpstreamProxy);
    if (proxyIdx < 0) continue;
    for (const h of arr.slice(0, proxyIdx) as Handler[]) {
      const del = (h?.request as { delete?: string[] } | undefined)?.delete;
      if (h?.handler === 'headers' && Array.isArray(del)) lists.push(del);
    }
  }
  return lists;
}

/** Every reverse_proxy handler that inspects its response: the auth subrequests. */
function authSubrequestHandlers(doc: unknown): Handler[] {
  const out: Handler[] = [];
  (function walk(node: unknown) {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      const obj = node as Handler;
      if (obj.handler === 'reverse_proxy' && obj.handle_response) out.push(obj);
      Object.values(obj).forEach(walk);
    }
  })(doc);
  return out;
}

function okRoutes(handler: Handler): Handler[] {
  const entries = handler.handle_response as Array<{
    match?: { status_code?: number[] };
    routes?: Handler[];
  }>;
  return entries.find((e) => e.match?.status_code?.includes(2))?.routes ?? [];
}

/** The header names a copy step sets on 2xx. */
function copiedNames(handler: Handler): string[] {
  const names: string[] = [];
  for (const route of okRoutes(handler)) {
    const set = (
      (route.handle as Handler[] | undefined)?.[0]?.request as
        | { set?: Record<string, string[]> }
        | undefined
    )?.set;
    if (set) names.push(...Object.keys(set));
  }
  return names;
}

/** The deletions the 2xx branch runs when the auth response lacks the header. */
function removalsWithoutAuthValue(handler: Handler): Array<{ del: string[]; matchKey: string }> {
  const out: Array<{ del: string[]; matchKey: string }> = [];
  for (const route of okRoutes(handler)) {
    const del = (
      (route.handle as Handler[] | undefined)?.[0]?.request as { delete?: string[] } | undefined
    )?.delete;
    const vars = (route.match as Array<{ vars?: Record<string, string[]> }> | undefined)?.[0]?.vars;
    if (del && vars) {
      const [matchKey] = Object.keys(vars);
      expect(vars[matchKey]).toEqual(['']);
      out.push({ del: lower(del).sort(), matchKey });
    }
  }
  return out;
}

const CREDENTIAL_HEADERS = ['Authorization', 'Proxy-Authorization', 'Cookie'];

function expectCredentialHeadersKept(lists: string[][]) {
  expect(lists.length).toBeGreaterThan(0);
  for (const del of lists) {
    const normalized = del.map((name) => name.toLowerCase().replace(/_/g, '-'));
    for (const cred of CREDENTIAL_HEADERS) expect(normalized).not.toContain(cred.toLowerCase());
  }
}

function genericForwardAuth(copyHeaders: string[], extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    provider: 'custom' as const,
    authUpstream: 'http://auth.example.com:9091',
    authEndpoint: '/verify',
    copyHeaders,
    ...extra,
  };
}

describe('identity-header strip leaves client credentials alone', () => {
  it('keeps Authorization/Cookie on every Authentik route but still copies them from the outpost', async () => {
    await createProxyHost(
      {
        name: 'ak-creds',
        domains: ['ak-creds.example.com'],
        upstreams: [UPSTREAM],
        authentik: {
          ...authentikBase,
          copyHeaders: [...AUTHENTIK_HEADERS, ...CREDENTIAL_HEADERS],
          excludedPaths: ['/api/*'],
        },
      },
      1,
    );
    const doc = await buildCaddyDocument();
    expectStripBeforeEveryUpstream(doc);
    expectCredentialHeadersKept(stripListsBeforeUpstream(doc));

    const [outpost] = authSubrequestHandlers(doc);
    expect(copiedNames(outpost)).toEqual(
      expect.arrayContaining([...AUTHENTIK_HEADERS, ...CREDENTIAL_HEADERS]),
    );
  });

  it("withholds the client's Authorization from the outpost route, keeping its cookies", async () => {
    for (const setOutpostHostHeader of [false, true]) {
      await ctx.db.delete(schema.proxyHosts);
      await createProxyHost(
        {
          name: 'ak-outpost',
          domains: ['ak-outpost.example.com'],
          upstreams: [UPSTREAM],
          authentik: { ...authentikBase, setOutpostHostHeader },
        },
        1,
      );
      const outpostRoutes: Handler[] = [];
      (function walk(node: unknown) {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const obj = node as Handler;
        if (JSON.stringify(obj.match ?? null).includes('/outpost.goauthentik.io/*')) {
          outpostRoutes.push(obj);
        }
        Object.values(obj).forEach(walk);
      })(await buildCaddyDocument());

      expect(outpostRoutes.length).toBeGreaterThan(0);
      for (const route of outpostRoutes) {
        const [proxy] = route.handle as Handler[];
        const request = (proxy.headers as { request: Record<string, unknown> }).request;
        expect(request.delete).toEqual(['Authorization']);
        expect(request.set).toEqual(
          setOutpostHostHeader ? { Host: ['{http.reverse_proxy.upstream.host}'] } : undefined,
        );
      }
    }
  });

  it('keeps Authorization/Cookie on every generic forward-auth route but still copies them', async () => {
    await createProxyHost(
      {
        name: 'fa-creds',
        domains: ['fa-creds.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: genericForwardAuth(['Remote-User', ...CREDENTIAL_HEADERS], {
          excludedPaths: ['/api/*'],
        }),
      },
      1,
    );
    const doc = await buildCaddyDocument();
    const lists = stripListsBeforeUpstream(doc);
    expectCredentialHeadersKept(lists);
    for (const del of lists) expect(del).toContain('Remote-User');

    const [auth] = authSubrequestHandlers(doc);
    expect(copiedNames(auth)).toEqual(
      expect.arrayContaining(['Remote-User', ...CREDENTIAL_HEADERS]),
    );
  });

  it('emits no strip handler when only credential headers are copied', async () => {
    await createProxyHost(
      {
        name: 'fa-only-creds',
        domains: ['fa-only-creds.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: genericForwardAuth(['Authorization']),
      },
      1,
    );
    expect(stripListsBeforeUpstream(await buildCaddyDocument())).toEqual([]);
  });
});

describe('credential copy headers the auth server does not return', () => {
  it('removes the client value on protected routes after the generic auth request', async () => {
    await createProxyHost(
      {
        name: 'fa-cred-rm',
        domains: ['fa-cred-rm.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: genericForwardAuth(['Remote-User', 'Authorization', 'Proxy_Authorization']),
      },
      1,
    );
    const [auth] = authSubrequestHandlers(await buildCaddyDocument());
    // The generic block stores names canonically, so "Proxy_Authorization" reads back lower-cased.
    expect(removalsWithoutAuthValue(auth)).toEqual([
      { del: ['authorization'], matchKey: '{http.reverse_proxy.header.Authorization}' },
      {
        del: ['proxy-authorization', 'proxy_authorization'],
        matchKey: '{http.reverse_proxy.header.Proxy_authorization}',
      },
    ]);
  });

  it('removes the client value after the Authentik outpost request', async () => {
    await createProxyHost(
      {
        name: 'ak-cred-rm',
        domains: ['ak-cred-rm.example.com'],
        upstreams: [UPSTREAM],
        authentik: { ...authentikBase, copyHeaders: [...AUTHENTIK_HEADERS, 'Cookie'] },
      },
      1,
    );
    const [outpost] = authSubrequestHandlers(await buildCaddyDocument());
    expect(removalsWithoutAuthValue(outpost)).toEqual([
      { del: ['cookie'], matchKey: '{http.reverse_proxy.header.Cookie}' },
    ]);
  });

  it('removes nothing when no credential header is copied', async () => {
    await createProxyHost(
      {
        name: 'fa-no-cred',
        domains: ['fa-no-cred.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: genericForwardAuth(['Remote-User']),
      },
      1,
    );
    const [auth] = authSubrequestHandlers(await buildCaddyDocument());
    expect(removalsWithoutAuthValue(auth)).toEqual([]);
  });
});

/** Go's textproto.CanonicalMIMEHeaderKey, the form Caddy's header `delete` matches on. */
function goCanonicalHeaderKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|-)([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/** Every spelling of `name` with each separator either "-" or "_". */
function separatorMixes(name: string): string[] {
  const i = name.search(/[-_]/);
  if (i < 0) return [name];
  const head = name.slice(0, i);
  return separatorMixes(name.slice(i + 1)).flatMap((tail) => [
    `${head}-${tail}`,
    `${head}_${tail}`,
  ]);
}

/** Asserts every pre-upstream delete list removes every separator mix of `headers`. */
function expectAllSeparatorMixesDeleted(doc: unknown, headers: string[], examples: string[]) {
  const lists = stripListsBeforeUpstream(doc);
  expect(lists.length).toBeGreaterThan(0);
  for (const del of lists) {
    const deleted = new Set(del.map(goCanonicalHeaderKey));
    // No entry is redundant under Caddy's case-insensitive matching.
    expect(deleted.size).toBe(del.length);
    for (const name of [...examples, ...headers.flatMap(separatorMixes)]) {
      expect(deleted.has(goCanonicalHeaderKey(name))).toBe(true);
    }
  }
}

describe('identity-header strip covers mixed separator spellings', () => {
  it('deletes every "-"/"_" mix of the CPM identity headers', async () => {
    await createProxyHost(
      {
        name: 'cpm-mix',
        domains: ['cpm-mix.example.com'],
        upstreams: [UPSTREAM],
        cpmForwardAuth: { enabled: true },
      },
      1,
    );
    expectAllSeparatorMixesDeleted(await buildCaddyDocument(), CPM_HEADERS, [
      'X_CPM_User',
      'X-CPM_User',
      'X-Cpm-User_Id',
      'x_cpm-user_id',
    ]);
  });

  it('deletes every "-"/"_" mix of the Authentik copy headers', async () => {
    const copyHeaders = [...AUTHENTIK_HEADERS, 'X-Authentik-Meta-Provider'];
    await createProxyHost(
      {
        name: 'ak-mix',
        domains: ['ak-mix.example.com'],
        upstreams: [UPSTREAM],
        authentik: { ...authentikBase, copyHeaders, excludedPaths: ['/public/*'] },
      },
      1,
    );
    expectAllSeparatorMixesDeleted(await buildCaddyDocument(), copyHeaders, [
      'X_Authentik_Username',
      'X-Authentik_Username',
      'X-Authentik-Meta_Provider',
    ]);
  });

  it('deletes every "-"/"_" mix of generic copy headers, whichever one is configured', async () => {
    await createProxyHost(
      {
        name: 'fa-mix',
        domains: ['fa-mix.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: genericForwardAuth(['Remote-User', 'X_Custom-Groups']),
      },
      1,
    );
    expectAllSeparatorMixesDeleted(
      await buildCaddyDocument(),
      ['Remote-User', 'X_Custom-Groups'],
      ['Remote_User', 'X-Custom_Groups', 'x-custom-groups'],
    );
  });

  it('falls back to the uniform spellings for names with more than six separators', async () => {
    await createProxyHost(
      {
        name: 'fa-long',
        domains: ['fa-long.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: genericForwardAuth(['X-A-B-C-D-E-F', 'X-A-B-C-D-E-F-G']),
      },
      1,
    );
    const lists = stripListsBeforeUpstream(await buildCaddyDocument());
    expect(lists.length).toBeGreaterThan(0);
    for (const del of lists) {
      // 2^6 mixes of the six-separator name, two spellings of the longer one.
      expect(del).toHaveLength(64 + 2);
      expect(del).toEqual(
        expect.arrayContaining([
          ...separatorMixes('X-A-B-C-D-E-F'),
          'X-A-B-C-D-E-F-G',
          'X_A_B_C_D_E_F_G',
        ]),
      );
    }
  });

  it('never deletes a credential header, whichever separator its configured name uses', async () => {
    await createProxyHost(
      {
        name: 'fa-cred-us',
        domains: ['fa-cred-us.example.com'],
        upstreams: [UPSTREAM],
        forwardAuth: genericForwardAuth(['Proxy_Authorization', 'COOKIE']),
      },
      1,
    );
    expect(stripListsBeforeUpstream(await buildCaddyDocument())).toEqual([]);
  });
});
