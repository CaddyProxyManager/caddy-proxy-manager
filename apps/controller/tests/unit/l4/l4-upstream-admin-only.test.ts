/**
 * An L4 upstream is a raw dial from inside Caddy's container: an operator aiming one at
 * caddy-admin:2019 would publish the admin API. New admin-port targets need an admin.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Outside the factory: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import {
  createL4ProxyHost,
  getL4ProxyHost,
  updateL4ProxyHost,
  type L4ProxyHostInput,
} from '../../../src/lib/models/l4-proxy-hosts';
import * as schema from '../../../src/lib/db/schema';

const ADMIN = 1;
const OPERATOR = 2;

beforeEach(async () => {
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  const now = new Date().toISOString();
  for (const [id, role] of [
    [ADMIN, 'admin'],
    [OPERATOR, 'operator'],
  ] as const) {
    await ctx.db.insert(schema.users).values({
      id,
      email: `${role}@example.com`,
      name: role,
      role,
      provider: 'credentials',
      subject: role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }
});

function input(upstreams: string[]): L4ProxyHostInput {
  return { name: 'tcp', protocol: 'tcp', listenAddress: ':5432', upstreams };
}

async function expectUpstreamAdminOnly(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: 'upstreamTargetAdminOnly' });
}

describe('L4 upstreams that reach the Caddy admin API are admin-only', () => {
  it.each(['caddy-admin:2019', 'caddy:2019', 'localhost:2019', '[::1]:2019', '127.0.0.1:2019'])(
    'refuses an operator adding %s',
    async (target) => {
      const host = await createL4ProxyHost(input(['10.0.0.5:5432']), ADMIN);
      await expectUpstreamAdminOnly(updateL4ProxyHost(host.id, { upstreams: [target] }, OPERATOR));
      expect((await getL4ProxyHost(host.id))?.upstreams).toEqual(['10.0.0.5:5432']);
    },
  );

  it('refuses an operator creating a host on the admin port', async () => {
    await expectUpstreamAdminOnly(createL4ProxyHost(input(['caddy-admin:2019']), OPERATOR));
  });

  it('lets an admin set one, and an operator keep it or change it to anything else', async () => {
    const host = await createL4ProxyHost(input(['caddy-admin:2019']), ADMIN);
    await updateL4ProxyHost(
      host.id,
      { name: 'renamed', upstreams: ['caddy-admin:2019'] },
      OPERATOR,
    );
    await updateL4ProxyHost(host.id, { enabled: false }, OPERATOR);
    await updateL4ProxyHost(host.id, { upstreams: ['10.0.0.5:2020'] }, OPERATOR);
    expect((await getL4ProxyHost(host.id))?.upstreams).toEqual(['10.0.0.5:2020']);
  });
});
