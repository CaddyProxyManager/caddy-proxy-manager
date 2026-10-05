/**
 * Integration: the global deny list against a real database - validation, the expiry pass, and
 * the handlers it puts first on every HTTP host.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../../helpers/db';
import { blockedSources, users } from '../../../src/lib/db/schema';
import type { DomainError } from '../../../src/lib/errors/domain-error';
import { logAuditEvent } from '../../../src/lib/audit';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));
const applyCaddyConfig = vi.fn(async () => {});
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig }));

import {
  createBlockedSource,
  deleteBlockedSource,
  listActiveBlockedSources,
  listBlockedSources,
  normalizeBlockedValue,
  pruneExpiredBlockedSources,
} from '../../../src/lib/models/blocked-sources';

let userId: number;

async function codeOf(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as DomainError).code ?? String(error);
  }
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  vi.clearAllMocks();
  const now = new Date().toISOString();
  const [user] = await ctx.db
    .insert(users)
    .values({
      email: 'admin@test',
      name: 'Admin',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@test',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  userId = user.id;
});

describe('normalizeBlockedValue', () => {
  it('stores each kind in one spelling', () => {
    expect(normalizeBlockedValue('ip', ' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeBlockedValue('ip', '[2001:DB8::1]')).toBe('2001:db8::1');
    expect(normalizeBlockedValue('cidr', '203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(normalizeBlockedValue('country', 'de')).toBe('DE');
    expect(normalizeBlockedValue('continent', 'eu')).toBe('EU');
    expect(normalizeBlockedValue('asn', 'AS64500')).toBe('64500');
  });

  it('refuses every address at once, in either family', async () => {
    expect(await codeOf(() => normalizeBlockedValue('cidr', '0.0.0.0/0'))).toBe(
      'blockedSourceCidrTooWide',
    );
    expect(await codeOf(() => normalizeBlockedValue('cidr', '::/0'))).toBe(
      'blockedSourceCidrTooWide',
    );
  });

  it('refuses values that do not fit the kind', async () => {
    expect(await codeOf(() => normalizeBlockedValue('ip', '203.0.113.0/24'))).toBe(
      'blockedSourceIpInvalid',
    );
    expect(await codeOf(() => normalizeBlockedValue('cidr', '203.0.113.7'))).toBe(
      'blockedSourceCidrInvalid',
    );
    expect(await codeOf(() => normalizeBlockedValue('country', 'XX'))).toBe(
      'blockedSourceCountryInvalid',
    );
    expect(await codeOf(() => normalizeBlockedValue('continent', 'ZZ'))).toBe(
      'blockedSourceContinentInvalid',
    );
    expect(await codeOf(() => normalizeBlockedValue('asn', '0'))).toBe('blockedSourceAsnInvalid');
  });
});

describe('createBlockedSource', () => {
  it('adds, applies and audits a block', async () => {
    const source = await createBlockedSource(
      { kind: 'ip', value: '203.0.113.7', reason: 'scanner' },
      userId,
    );
    expect(source).toMatchObject({ kind: 'ip', value: '203.0.113.7', reason: 'scanner' });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'blocked_source', summary: 'Blocked ip 203.0.113.7' }),
    );
    expect((await listBlockedSources())[0]?.createdBy).toBe('Admin');
  });

  it('updates the reason and expiry of a source already listed', async () => {
    await createBlockedSource({ kind: 'country', value: 'de' }, userId);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await createBlockedSource(
      { kind: 'country', value: 'DE', reason: 'again', expiresAt: later },
      userId,
    );
    const rows = await listBlockedSources();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'again', expiresAt: later });
  });

  it('refuses an expiry in the past and an unknown kind', async () => {
    expect(
      await codeOf(() =>
        createBlockedSource(
          { kind: 'ip', value: '203.0.113.7', expiresAt: '2000-01-01T00:00:00Z' },
          userId,
        ),
      ),
    ).toBe('blockedSourceExpiryInvalid');
    expect(await codeOf(() => createBlockedSource({ kind: 'host', value: 'x' }, userId))).toBe(
      'blockedSourceKindInvalid',
    );
    expect(await listBlockedSources()).toEqual([]);
  });
});

describe('expiry', () => {
  it('leaves expired entries out of the config at once, and deletes them on the next pass', async () => {
    const now = Date.now();
    await ctx.db.insert(blockedSources).values([
      {
        kind: 'ip',
        value: '203.0.113.7',
        reason: '',
        expiresAt: new Date(now - 1000).toISOString(),
        createdAt: new Date(now - 5000).toISOString(),
      },
      {
        kind: 'ip',
        value: '203.0.113.8',
        reason: '',
        expiresAt: new Date(now + 60_000).toISOString(),
        createdAt: new Date(now).toISOString(),
      },
      {
        kind: 'asn',
        value: '64500',
        reason: '',
        expiresAt: null,
        createdAt: new Date(now).toISOString(),
      },
    ]);
    expect((await listActiveBlockedSources(now)).map((s) => s.value)).toEqual([
      '203.0.113.8',
      '64500',
    ]);

    const apply = vi.fn(async () => {});
    expect(await pruneExpiredBlockedSources(now, apply)).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect((await listBlockedSources()).map((s) => s.value).sort()).toEqual([
      '203.0.113.8',
      '64500',
    ]);

    // Nothing more to do, so no second reload.
    expect(await pruneExpiredBlockedSources(now, apply)).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('unblocks by hand', async () => {
    const source = await createBlockedSource({ kind: 'cidr', value: '198.51.100.0/24' }, userId);
    await deleteBlockedSource(source.id, userId);
    expect(await listBlockedSources()).toEqual([]);
    expect(await codeOf(() => deleteBlockedSource(source.id, userId))).toBe(
      'blockedSourceNotFound',
    );
  });
});
