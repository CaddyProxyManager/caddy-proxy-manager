/**
 * Integration: starting WAF override mode (src/lib/models/waf-overrides.ts) against a real
 * database - which addresses it takes, and that a refused start stores and applies nothing.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '../../helpers/db';
import { proxyHosts, users, wafOverrideSessions } from '../../../src/lib/db/schema';
import type { DomainError } from '../../../src/lib/errors/domain-error';

let db: TestDb;

vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));
vi.mock('../../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
const applyCaddyConfig = vi.fn(async () => {});
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig }));
vi.mock('../../../src/lib/clickhouse/client', () => ({ isAnalyticsEnabled: async () => true }));
vi.mock('../../../src/lib/settings', () => ({ getWafSettings: async () => null }));

import { startWafOverride } from '../../../src/lib/models/waf-overrides';

let userId: number;
let hostId: number;

beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  const now = new Date().toISOString();
  const [user] = await db
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
  const [host] = await db
    .insert(proxyHosts)
    .values({
      name: 'app',
      domains: JSON.stringify(['app.example.com']),
      upstreams: JSON.stringify(['app:8080']),
      meta: JSON.stringify({ waf: { enabled: true, mode: 'On', waf_mode: 'override' } }),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  hostId = host.id;
});

async function codeOf(ip: string): Promise<string | null> {
  try {
    await startWafOverride(hostId, ip, userId);
    return null;
  } catch (error) {
    return (error as DomainError).code ?? String(error);
  }
}

describe('startWafOverride', () => {
  it('refuses a loopback address and stores and applies nothing', async () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      expect([ip, await codeOf(ip)]).toEqual([ip, 'wafOverrideAddressLoopback']);
    }
    expect(await db.select().from(wafOverrideSessions)).toEqual([]);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('takes an ordinary address and applies the config', async () => {
    const session = await startWafOverride(hostId, '203.0.113.9', userId);
    expect(session).toMatchObject({ proxyHostId: hostId, clientIp: '203.0.113.9', endedAt: null });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
  });
});
