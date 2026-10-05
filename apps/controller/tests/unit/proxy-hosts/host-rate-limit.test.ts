/** Per-host rate limiting: the stored shape, what the editor and API may send, and the handler. */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import {
  buildRateLimitHandler,
  hydrateHostRateLimit,
  normalizeHostRateLimitInput,
  RATE_LIMIT_MAX_ZONES,
  rateLimitZoneName,
  sanitizeHostRateLimit,
} from '../../../src/lib/proxy-hosts/rate-limit';
import {
  createProxyHost,
  getProxyHost,
  updateProxyHost,
} from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import {
  parseProxyHostOptionUpdates,
  parseRateLimitConfig,
} from '../../../src/lib/proxy-hosts/form';
import { DomainError } from '../../../src/lib/errors/domain-error';
import * as schema from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();
const ZONE = { paths: ['/login'], maxEvents: 10, window: '1m', key: 'ip', ipv6Prefix: 64 };

function refusal(value: unknown): string | undefined {
  try {
    normalizeHostRateLimitInput(value);
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
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
    createdAt: NOW,
    updatedAt: NOW,
  });
});

describe('buildRateLimitHandler', () => {
  it('keys on http.vars.client_ip, the placeholder that honours trusted proxies', () => {
    const handler = buildRateLimitHandler(
      7,
      normalizeHostRateLimitInput({ enabled: true, zones: [ZONE] }),
    );
    const zones = handler?.rate_limits as Record<string, Record<string, unknown>>;
    expect(zones.h7_0.key).toBe('{http.vars.client_ip}');
    // Does not exist in Caddy: it would expand to empty and share one bucket between everyone.
    expect(JSON.stringify(handler)).not.toContain('http.request.client_ip');
  });

  it('adds the path to the key for ip+path, and leaves the IPv6 prefix out', () => {
    const meta = normalizeHostRateLimitInput({
      enabled: true,
      zones: [{ ...ZONE, paths: [], key: 'ip+path' }],
    });
    expect(buildRateLimitHandler(3, meta)).toEqual({
      handler: 'rate_limit',
      rate_limits: {
        h3_0: {
          key: '{http.vars.client_ip} {http.request.uri.path}',
          window: '1m',
          max_events: 10,
        },
      },
    });
  });

  it('names zones by host id and position', () => {
    expect(rateLimitZoneName(12, 0)).toBe('h12_0');
    const meta = normalizeHostRateLimitInput({ enabled: true, zones: [ZONE, ZONE] });
    expect(Object.keys(buildRateLimitHandler(12, meta)?.rate_limits as object)).toEqual([
      'h12_0',
      'h12_1',
    ]);
  });

  it('is null while off or without zones', () => {
    expect(buildRateLimitHandler(1, undefined)).toBeNull();
    expect(buildRateLimitHandler(1, { enabled: false, zones: [] })).toBeNull();
    expect(buildRateLimitHandler(1, { enabled: true, zones: [] })).toBeNull();
    const off = normalizeHostRateLimitInput({ enabled: false, zones: [ZONE] });
    expect(buildRateLimitHandler(1, off)).toBeNull();
  });
});

describe('input and stored values', () => {
  it('refuses what Caddy would reject', () => {
    expect(refusal({ enabled: true, zones: [{ ...ZONE, window: '0s' }] })).toBe(
      'hostRateLimitWindowInvalid',
    );
    expect(refusal({ enabled: true, zones: [{ ...ZONE, window: '60' }] })).toBe(
      'hostRateLimitWindowInvalid',
    );
    expect(refusal({ enabled: true, zones: [{ ...ZONE, maxEvents: 0 }] })).toBe(
      'hostRateLimitMaxEventsInvalid',
    );
    expect(refusal({ enabled: true, zones: [{ ...ZONE, maxEvents: 1.5 }] })).toBe(
      'hostRateLimitMaxEventsInvalid',
    );
    expect(refusal({ enabled: true, zones: [{ ...ZONE, ipv6Prefix: 129 }] })).toBe(
      'hostRateLimitIpv6PrefixInvalid',
    );
    expect(refusal({ enabled: true, zones: [{ ...ZONE, paths: ['/{http.request.host}'] }] })).toBe(
      'hostRateLimitPathInvalid',
    );
    expect(
      refusal({
        enabled: true,
        zones: Array.from({ length: RATE_LIMIT_MAX_ZONES + 1 }, () => ZONE),
      }),
    ).toBe('hostRateLimitTooManyZones');
    expect(refusal({ enabled: true, zones: [ZONE] })).toBeUndefined();
    expect(refusal({ enabled: true, zones: [{ ...ZONE, window: '1.5s' }] })).toBeUndefined();
  });

  it('drops an unreadable stored zone rather than failing the config', () => {
    expect(
      sanitizeHostRateLimit({
        enabled: true,
        zones: [
          { max_events: 5, window: 'soon', key: 'ip' },
          { max_events: 5, window: '10s', key: 'bogus', paths: ['/a', '{x}'] },
        ],
      }),
    ).toEqual({
      enabled: true,
      zones: [{ max_events: 5, window: '10s', key: 'ip', paths: ['/a'] }],
    });
    expect(sanitizeHostRateLimit({ enabled: false, zones: [] })).toBeUndefined();
    expect(sanitizeHostRateLimit('nonsense')).toBeUndefined();
  });

  it('hydrates the API shape back', () => {
    expect(
      hydrateHostRateLimit(normalizeHostRateLimitInput({ enabled: true, zones: [ZONE] })),
    ).toEqual({
      enabled: true,
      zones: [{ paths: ['/login'], maxEvents: 10, window: '1m', key: 'ip', ipv6Prefix: 64 }],
    });
    expect(hydrateHostRateLimit(undefined)).toBeNull();
  });
});

describe('the editor form', () => {
  it('reads the card, and leaves the host alone without it', () => {
    expect(parseRateLimitConfig(form({}))).toBeUndefined();
    expect(
      parseRateLimitConfig(
        form({
          rateLimitPresent: '1',
          rateLimitEnabled: 'on',
          rateLimitZonesJson: JSON.stringify([ZONE]),
        }),
      ),
    ).toEqual({ enabled: true, zones: [ZONE] as never });
    expect(
      parseProxyHostOptionUpdates(form({ rateLimitPresent: '1', rateLimitZonesJson: 'not json' }))
        .rateLimit,
    ).toEqual({ enabled: false, zones: [] });
  });
});

describe('the model', () => {
  it('stores zones, keeps them while off, and forgets them on null', async () => {
    const host = await createProxyHost(
      {
        name: 'rl',
        domains: ['rl.example.com'],
        upstreams: ['10.0.0.5:8080'],
        rateLimit: { enabled: true, zones: [ZONE] as never },
      },
      1,
    );
    expect(host.rateLimit).toEqual({ enabled: true, zones: [ZONE] as never });

    await updateProxyHost(host.id, { rateLimit: { enabled: false, zones: [ZONE] as never } }, 1);
    expect((await getProxyHost(host.id))?.rateLimit).toEqual({
      enabled: false,
      zones: [ZONE] as never,
    });

    // An unrelated edit keeps them.
    await updateProxyHost(host.id, { name: 'renamed' }, 1);
    expect((await getProxyHost(host.id))?.rateLimit?.zones).toHaveLength(1);

    await updateProxyHost(host.id, { rateLimit: null }, 1);
    expect((await getProxyHost(host.id))?.rateLimit).toBeNull();
  });

  it('refuses a bad zone from the API', async () => {
    await expect(
      createProxyHost(
        {
          name: 'bad',
          domains: ['bad.example.com'],
          upstreams: ['10.0.0.5:8080'],
          rateLimit: { enabled: true, zones: [{ ...ZONE, window: 'forever' }] as never },
        },
        1,
      ),
    ).rejects.toThrow(/Rate limit window "forever"/);
  });

  it('is left out of the document when the shipped image lacks the module', async () => {
    // No agent: generation assumes the shipped image, which leaves the opt-in module out.
    await createProxyHost(
      {
        name: 'shipped',
        domains: ['shipped.example.com'],
        upstreams: ['10.0.0.5:8080'],
        rateLimit: { enabled: true, zones: [ZONE] as never },
      },
      1,
    );
    expect(JSON.stringify(await buildCaddyDocument())).not.toContain('"rate_limit"');
  });
});
