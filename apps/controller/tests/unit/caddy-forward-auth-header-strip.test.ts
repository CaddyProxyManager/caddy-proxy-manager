/**
 * Regression (SECURITY-AUDIT H1): forward-auth hosts must STRIP client-supplied X-CPM-* headers on
 * EVERY proxying route. Otherwise unprotected and excluded paths pass forged headers through, and
 * authenticated routes only overwrite when the verify value is non-empty.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

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
