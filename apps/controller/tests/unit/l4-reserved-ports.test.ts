/**
 * SECURITY-AUDIT M8: an L4 listen port is published on the Caddy container, so a host on :2019 put
 * the Caddy admin API on the host network. Reserved ports are refused on save, and skipped when
 * publishing in case a row predates the check.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (value: string | Date | null | undefined): string | null => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    },
  };
});

vi.mock('../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import { eq } from 'drizzle-orm';
import {
  createL4ProxyHost,
  updateL4ProxyHost,
  type L4ProxyHostInput,
} from '../../src/lib/models/l4-proxy-hosts';
import { getRequiredL4Ports } from '../../src/lib/l4-ports';
import { saveMetricsSettings } from '../../src/lib/settings';
import { RESERVED_L4_PORTS } from '../../src/lib/caddy-utils';
import { DomainError } from '../../src/lib/domain-error';
import * as schema from '../../src/lib/db/schema';

beforeEach(async () => {
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    role: 'admin',
    provider: 'credentials',
    subject: 'test',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

const input = (listenAddress: string, protocol: 'tcp' | 'udp' = 'tcp'): L4ProxyHostInput => ({
  name: `l4 ${listenAddress}`,
  protocol,
  listenAddress,
  upstreams: ['10.0.0.1:5432'],
});

describe('reserved L4 listen ports', () => {
  it('covers the Caddy admin, HTTP, HTTPS, metrics and controller ports', () => {
    expect([...RESERVED_L4_PORTS].sort((a, b) => a - b)).toEqual([80, 443, 2019, 3000, 9090]);
  });

  for (const port of RESERVED_L4_PORTS) {
    it(`rejects creating a host on :${port}`, async () => {
      const failure = createL4ProxyHost(input(`:${port}`), 1);
      await expect(failure).rejects.toBeInstanceOf(DomainError);
      await expect(failure).rejects.toMatchObject({
        code: 'l4ListenPortReserved',
        params: { port },
      });
    });
  }

  it('rejects a reserved port behind a host part and over UDP', async () => {
    await expect(createL4ProxyHost(input('0.0.0.0:2019'), 1)).rejects.toMatchObject({
      code: 'l4ListenPortReserved',
    });
    await expect(createL4ProxyHost(input('[::1]:443', 'udp'), 1)).rejects.toMatchObject({
      code: 'l4ListenPortReserved',
    });
  });

  it('rejects moving an existing host onto a reserved port', async () => {
    const host = await createL4ProxyHost(input(':5432'), 1);
    await expect(updateL4ProxyHost(host.id, { listenAddress: ':2019' }, 1)).rejects.toMatchObject({
      code: 'l4ListenPortReserved',
    });
  });

  it('does not publish a reserved port stored before the check existed', async () => {
    await createL4ProxyHost(input(':5432'), 1);
    const legacy = await createL4ProxyHost(input(':6000', 'udp'), 1);
    await ctx.db
      .update(schema.l4ProxyHosts)
      .set({ listenAddress: ':2019' })
      .where(eq(schema.l4ProxyHosts.id, legacy.id));

    expect(await getRequiredL4Ports()).toEqual(['5432:5432']);
  });
});

describe('the configured metrics port', () => {
  it('is refused while metrics listen on it, and free once they are off', async () => {
    try {
      await saveMetricsSettings({ enabled: true, port: 9180 });
      await expect(createL4ProxyHost(input(':9180'), 1)).rejects.toMatchObject({
        code: 'l4ListenPortReserved',
        params: { port: 9180 },
      });
      await saveMetricsSettings({ enabled: false, port: 9180 });
      await expect(createL4ProxyHost(input(':9180'), 1)).resolves.toBeDefined();
    } finally {
      await saveMetricsSettings({ enabled: false });
    }
  });

  it('is not published for a row stored while metrics were off', async () => {
    try {
      await createL4ProxyHost(input(':9180'), 1);
      await saveMetricsSettings({ enabled: true, port: 9180 });
      expect(await getRequiredL4Ports()).toEqual([]);
    } finally {
      await saveMetricsSettings({ enabled: false });
    }
  });
});
