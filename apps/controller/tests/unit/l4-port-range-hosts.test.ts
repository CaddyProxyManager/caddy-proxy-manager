/** Port ranges and same-port upstreams through the L4 host model: what a save refuses and stores. */
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

import {
  createL4ProxyHost,
  getL4ProxyHost,
  updateL4ProxyHost,
  type L4ProxyHostInput,
} from '../../src/lib/models/l4-proxy-hosts';
import { saveMetricsSettings } from '../../src/lib/settings';
import * as schema from '../../src/lib/db/schema';

beforeEach(async () => {
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.settings);
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

const input = (overrides: Partial<L4ProxyHostInput> = {}): L4ProxyHostInput => ({
  name: 'games',
  protocol: 'udp',
  listenAddress: ':27015-27030',
  upstreams: ['10.0.0.5:27015'],
  ...overrides,
});

describe('listen ranges', () => {
  it('stores a range as written', async () => {
    const host = await createL4ProxyHost(input(), 1);
    expect(host.listenAddress).toBe(':27015-27030');
    expect(host.upstreamPortMode).toBe('fixed');
  });

  it('refuses more than 1000 ports, and a backwards range', async () => {
    await expect(
      createL4ProxyHost(input({ listenAddress: ':20000-21000' }), 1),
    ).rejects.toMatchObject({ code: 'l4ListenRangeTooLarge', params: { max: 1000 } });
    await createL4ProxyHost(input({ listenAddress: ':20000-20999' }), 1);
    await expect(
      createL4ProxyHost(input({ listenAddress: ':5010-5000' }), 1),
    ).rejects.toMatchObject({
      code: 'l4ListenAddressInvalid',
    });
  });

  it('refuses a range with a reserved port inside it, the metrics port included', async () => {
    await expect(
      createL4ProxyHost(input({ listenAddress: ':2000-2100' }), 1),
    ).rejects.toMatchObject({
      code: 'l4ListenPortReserved',
      params: { port: 2019 },
      // A 400 on /api/v1, not an unhandled 500 (docker-tests caught that).
      status: 400,
    });
    await saveMetricsSettings({ enabled: true, port: 9180 });
    await expect(
      createL4ProxyHost(input({ listenAddress: ':9100-9200' }), 1),
    ).rejects.toMatchObject({
      code: 'l4ListenPortReserved',
      params: { port: 9180 },
      status: 400,
    });
  });

  it('refuses a range over an enabled host on another listen address', async () => {
    await createL4ProxyHost(input({ name: 'rcon', listenAddress: ':27020' }), 1);
    await expect(createL4ProxyHost(input(), 1)).rejects.toMatchObject({
      code: 'l4ListenPortInUse',
      params: { port: 27020 },
    });
    // Created disabled it claims nothing, until it is enabled.
    const host = await createL4ProxyHost(input({ enabled: false }), 1);
    await expect(updateL4ProxyHost(host.id, { enabled: true }, 1)).rejects.toMatchObject({
      code: 'l4ListenPortInUse',
    });
    // TCP on the same ports is another listener.
    await createL4ProxyHost(input({ name: 'tcp', protocol: 'tcp' }), 1);
  });

  it('refuses moving a host onto a clashing range, but not an unrelated edit', async () => {
    await createL4ProxyHost(input({ name: 'rcon', listenAddress: ':27020' }), 1);
    const host = await createL4ProxyHost(input({ listenAddress: ':28000-28010' }), 1);
    await expect(
      updateL4ProxyHost(host.id, { listenAddress: ':27015-27030' }, 1),
    ).rejects.toMatchObject({ code: 'l4ListenPortInUse' });
    await updateL4ProxyHost(host.id, { name: 'renamed' }, 1);
    expect((await getL4ProxyHost(host.id))?.name).toBe('renamed');
  });
});

describe('same-port upstreams', () => {
  it('stores bare hosts and the mode, and switches back', async () => {
    const host = await createL4ProxyHost(
      input({ upstreams: ['srcds', '[2001:db8::5]'], upstreamPortMode: 'same' }),
      1,
    );
    expect(host.upstreamPortMode).toBe('same');
    expect(host.meta).toMatchObject({ upstream_port_mode: 'same' });

    // An unrelated edit keeps the mode.
    await updateL4ProxyHost(host.id, { name: 'renamed', geoblockMode: 'merge' }, 1);
    expect((await getL4ProxyHost(host.id))?.upstreamPortMode).toBe('same');

    // Switching back needs upstreams with ports again.
    await expect(
      updateL4ProxyHost(host.id, { upstreamPortMode: 'fixed' }, 1),
    ).rejects.toMatchObject({ code: 'l4UpstreamInvalid' });
    const fixed = await updateL4ProxyHost(
      host.id,
      { upstreamPortMode: 'fixed', upstreams: ['srcds:27015'] },
      1,
    );
    expect(fixed.upstreamPortMode).toBe('fixed');
    expect(fixed.meta?.upstream_port_mode).toBeUndefined();
  });

  it('refuses an upstream with a port in same mode, and a bare one in fixed mode', async () => {
    await expect(
      createL4ProxyHost(input({ upstreams: ['srcds:27015'], upstreamPortMode: 'same' }), 1),
    ).rejects.toMatchObject({ code: 'l4SamePortUpstreamInvalid' });
    await expect(createL4ProxyHost(input({ upstreams: ['srcds'] }), 1)).rejects.toMatchObject({
      code: 'l4UpstreamInvalid',
    });
  });

  it('refuses a mode it does not know', async () => {
    await expect(
      createL4ProxyHost(input({ upstreamPortMode: 'next' as never }), 1),
    ).rejects.toMatchObject({ code: 'l4UpstreamPortModeInvalid' });
  });

  it('refuses an active health check, on create and when switching an existing host', async () => {
    const activeHealthCheck = { enabled: true, port: null, interval: '10s', timeout: null };
    await expect(
      createL4ProxyHost(
        input({
          upstreams: ['srcds'],
          upstreamPortMode: 'same',
          loadBalancer: { enabled: true, activeHealthCheck },
        }),
        1,
      ),
    ).rejects.toMatchObject({ code: 'l4SamePortActiveHealthCheck' });

    const host = await createL4ProxyHost(
      input({ loadBalancer: { enabled: true, activeHealthCheck } }),
      1,
    );
    await expect(
      updateL4ProxyHost(host.id, { upstreamPortMode: 'same', upstreams: ['srcds'] }, 1),
    ).rejects.toMatchObject({ code: 'l4SamePortActiveHealthCheck' });
    await updateL4ProxyHost(
      host.id,
      {
        upstreamPortMode: 'same',
        upstreams: ['srcds'],
        loadBalancer: {
          enabled: true,
          activeHealthCheck: { ...activeHealthCheck, enabled: false },
        },
      },
      1,
    );
    expect((await getL4ProxyHost(host.id))?.upstreamPortMode).toBe('same');
  });

  it('ignores a mode smuggled in through raw meta', async () => {
    const host = await createL4ProxyHost(input({ meta: { upstream_port_mode: 'same' } }), 1);
    expect(host.upstreamPortMode).toBe('fixed');
  });
});
