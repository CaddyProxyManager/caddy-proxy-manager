import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// bun evaluates a vi.mock factory synchronously while linking, so the helpers it needs
// are imported above it rather than awaited inside it.
const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
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

// The real config builder is kept; only the live apply is stubbed. bun has no importOriginal, so
// the module is imported above the mock - the import runs before the mock replaces it.
const actualCaddy = await import('../../src/lib/caddy');

vi.mock('../../src/lib/caddy', () => ({
  ...actualCaddy,
  applyCaddyConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { createProxyHost } from '../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { saveDefaultResponseSettings } from '../../src/lib/settings';
import {
  buildDefaultResponseRoute,
  DefaultResponseValidationError,
  normalizeDefaultResponseSettings,
  parseDefaultResponseHeaders,
} from '../../src/lib/caddy-default-response';
import { DomainError } from '../../src/lib/domain-error';
import * as schema from '../../src/lib/db/schema';

type CpmServer = { listen?: string[]; routes?: Array<Record<string, unknown>> };

function cpmServer(document: unknown): CpmServer | undefined {
  return (document as { apps?: { http?: { servers?: { cpm?: CpmServer } } } }).apps?.http?.servers
    ?.cpm;
}

async function seedAdminAndHost() {
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await createProxyHost(
    { name: 'Known host', domains: ['known.example.test'], upstreams: ['10.0.0.5:8080'] },
    1,
  );
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users);
});

describe('default response validation and route builder', () => {
  it("omits a route for Caddy's native default", () => {
    expect(buildDefaultResponseRoute(null)).toBeNull();
    expect(buildDefaultResponseRoute({ mode: 'caddy' })).toBeNull();
  });

  it("builds custom response headers in Caddy's array-valued format", () => {
    expect(
      buildDefaultResponseRoute({
        mode: 'respond',
        status: 418,
        body: 'CPM_DEFAULT_RESPONSE',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Default': 'yes' },
      }),
    ).toEqual({
      handle: [
        {
          handler: 'static_response',
          status_code: 418,
          body: 'CPM_DEFAULT_RESPONSE',
          headers: {
            'Content-Type': ['text/plain; charset=utf-8'],
            'X-Default': ['yes'],
          },
        },
      ],
      terminal: true,
    });
  });

  it("uses Caddy's abort response for no-response mode", () => {
    expect(buildDefaultResponseRoute({ mode: 'abort' })).toEqual({
      handle: [{ handler: 'static_response', abort: true }],
      terminal: true,
    });
  });

  it('builds redirects and gives Location precedence over custom headers', () => {
    const settings = normalizeDefaultResponseSettings({
      mode: 'redirect',
      status: 308,
      redirectUrl: 'https://example.com{http.request.uri}',
      headers: { location: 'https://ignored.example', 'Cache-Control': 'no-store' },
    });
    expect(buildDefaultResponseRoute(settings)).toEqual({
      handle: [
        {
          handler: 'static_response',
          status_code: 308,
          headers: {
            Location: ['https://example.com{http.request.uri}'],
            'Cache-Control': ['no-store'],
          },
        },
      ],
      terminal: true,
    });
  });

  it('rejects invalid status codes and header injection', () => {
    expect(() => normalizeDefaultResponseSettings({ mode: 'respond', status: 103 })).toThrow(
      /200 to 599/,
    );
    expect(() =>
      normalizeDefaultResponseSettings({
        mode: 'respond',
        status: 404,
        headers: { 'X-Test': 'safe\r\nInjected: value' },
      }),
    ).toThrow(/Invalid value/);
    expect(() =>
      normalizeDefaultResponseSettings({
        mode: 'respond',
        headers: { 'X-Test': 'unsafe\u0000value' },
      }),
    ).toThrow(/Invalid value/);
    expect(() =>
      normalizeDefaultResponseSettings({
        mode: 'respond',
        headers: { 'X-Test': 'one', 'x-test': 'two' },
      }),
    ).toThrow(/Duplicate/);
    expect(() =>
      normalizeDefaultResponseSettings({
        mode: 'redirect',
        redirectUrl: 'https://example.test/\u0000',
      }),
    ).toThrow(/control characters/);
  });
});

describe('buildCaddyDocument default response', () => {
  it('preserves the current no-server document when there are no hosts or setting', async () => {
    expect(cpmServer(await buildCaddyDocument())).toBeUndefined();
  });

  it('creates the HTTP server for a custom response even with zero proxy hosts', async () => {
    await saveDefaultResponseSettings({
      mode: 'respond',
      status: 404,
      body: 'Not Found',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });

    const server = cpmServer(await buildCaddyDocument());
    expect(server?.listen).toEqual([':80']);
    // After the reachability probe, which every server answers first.
    expect(JSON.stringify(server?.routes?.[0])).toContain('cpm-reachability');
    expect(server?.routes?.slice(1)).toEqual([
      {
        handle: [
          {
            handler: 'static_response',
            status_code: 404,
            body: 'Not Found',
            headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
          },
        ],
        terminal: true,
      },
    ]);
  });

  it('keeps the matcher-less response last so a configured host still wins', async () => {
    await seedAdminAndHost();
    await saveDefaultResponseSettings({ mode: 'respond', status: 403, body: 'Forbidden' });

    const routes = cpmServer(await buildCaddyDocument())?.routes ?? [];
    expect(routes.length).toBeGreaterThan(1);
    expect(routes.slice(0, -1).every((route) => route.match !== undefined)).toBe(true);
    expect(JSON.stringify(routes.slice(0, -1))).toContain('known.example.test');
    expect(routes.at(-1)).toEqual({
      handle: [{ handler: 'static_response', status_code: 403, body: 'Forbidden' }],
      terminal: true,
    });
  });

  it('does not append a catch-all route when mode is reset to caddy', async () => {
    await seedAdminAndHost();
    await saveDefaultResponseSettings({ mode: 'caddy' });

    const routes = cpmServer(await buildCaddyDocument())?.routes ?? [];
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.match !== undefined)).toBe(true);
    expect(JSON.stringify(routes)).toContain('known.example.test');
  });
});

describe('parseDefaultResponseHeaders', () => {
  it('reads one Name: value per line and skips blank lines', () => {
    expect(parseDefaultResponseHeaders('X-One: 1\r\n\n  X-Two :  two: parts  ')).toEqual({
      'X-One': '1',
      'X-Two': 'two: parts',
    });
  });

  it('treats an empty box, or no box, as no headers', () => {
    expect(parseDefaultResponseHeaders('  \n ')).toBeUndefined();
    expect(parseDefaultResponseHeaders(null)).toBeUndefined();
  });

  it('refuses a line with no name by code, carrying the line as written', () => {
    let caught: unknown;
    try {
      parseDefaultResponseHeaders('X-Ok: 1\n: no name');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('defaultResponseHeaderLineInvalid');
    expect((caught as DomainError).params).toEqual({ line: ': no name' });
    expect((caught as DomainError).message).toBe('Invalid response header line: : no name');
  });
});

describe('normalizeDefaultResponseSettings refusals', () => {
  /** The error it throws for `value`, so the code and the English can both be checked. */
  function refusal(value: unknown): DomainError {
    try {
      normalizeDefaultResponseSettings(value);
    } catch (error) {
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }

  it('raises codes whose English is what /api/v1 has always returned', () => {
    const cases: Array<[unknown, string, string]> = [
      [[], 'defaultResponseSettingsNotObject', 'Default response settings must be an object'],
      [
        { mode: 'teapot' },
        'defaultResponseModeInvalid',
        'Default response mode must be caddy, respond, redirect, or abort',
      ],
      [
        { mode: 'respond', headers: [] },
        'defaultResponseHeadersNotObject',
        'Default response headers must be an object',
      ],
      [
        { mode: 'respond', headers: { 'Bad Name': 'x' } },
        'defaultResponseHeaderNameInvalid',
        'Invalid default response header name: Bad Name',
      ],
      [
        { mode: 'respond', headers: { 'X-A': '1', 'x-a': '2' } },
        'defaultResponseHeaderNameDuplicate',
        'Duplicate default response header name: x-a',
      ],
      [
        { mode: 'respond', headers: { 'X-A': 'bad\0' } },
        'defaultResponseHeaderValueInvalid',
        'Invalid value for default response header: X-A',
      ],
      [
        { mode: 'redirect', status: 200, redirectUrl: 'https://example.test' },
        'defaultRedirectStatusInvalid',
        'Default redirect status must be 301, 302, 303, 307, or 308',
      ],
      [
        { mode: 'redirect', redirectUrl: ' ' },
        'defaultRedirectUrlInvalid',
        'Default redirect URL is required and must not contain control characters',
      ],
      [
        { mode: 'respond', status: 103 },
        'defaultResponseStatusInvalid',
        'Default response status must be an integer from 200 to 599',
      ],
      [
        { mode: 'respond', body: 7 },
        'defaultResponseBodyNotString',
        'Default response body must be a string',
      ],
    ];
    for (const [value, code, message] of cases) {
      const error = refusal(value);
      expect(error).toBeInstanceOf(DefaultResponseValidationError);
      expect(error).toBeInstanceOf(DomainError);
      expect(error.code as string).toBe(code);
      expect(error.message).toBe(message);
    }
  });
});
