/** "Leave out of the access log": a log_skip var ahead of every other handler. */
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
  createProxyHost,
  getProxyHost,
  updateProxyHost,
} from '../../../src/lib/models/proxy-hosts';
import { buildCaddyDocument } from '../../../src/lib/caddy';
import { parseProxyHostOptionUpdates } from '../../../src/lib/proxy-hosts/form';
import * as schema from '../../../src/lib/db/schema';
import { chainsTo, withoutMarkers } from '../../helpers/host-chains';

const NOW = new Date().toISOString();
const UPSTREAM = '10.0.0.5:8080';

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

async function chainFor(domain: string, skipAccessLog: boolean) {
  await createProxyHost(
    { name: domain, domains: [domain], upstreams: [UPSTREAM], skipAccessLog },
    1,
  );
  const chains = chainsTo(await buildCaddyDocument(), UPSTREAM);
  expect(chains.length).toBeGreaterThan(0);
  return chains[0];
}

describe('skipAccessLog', () => {
  it('puts log_skip ahead of every other handler', async () => {
    const chain = await chainFor('quiet.example.com', true);
    expect(withoutMarkers(chain)[0]).toEqual({ handler: 'vars', log_skip: true });
  });

  it('adds nothing when off', async () => {
    const chain = await chainFor('loud.example.com', false);
    expect(JSON.stringify(chain)).not.toContain('log_skip');
  });

  it('is read from the form only when its toggle was rendered', () => {
    const on = new FormData();
    on.set('skipAccessLogPresent', '1');
    on.set('skipAccessLog', 'on');
    expect(parseProxyHostOptionUpdates(on).skipAccessLog).toBe(true);

    const off = new FormData();
    off.set('skipAccessLogPresent', '1');
    expect(parseProxyHostOptionUpdates(off).skipAccessLog).toBe(false);

    expect(parseProxyHostOptionUpdates(new FormData()).skipAccessLog).toBeUndefined();
  });

  it('survives an update that leaves it out, and clears when turned off', async () => {
    const host = await createProxyHost(
      { name: 'k', domains: ['k.example.com'], upstreams: [UPSTREAM], skipAccessLog: true },
      1,
    );
    await updateProxyHost(host.id, { name: 'renamed' }, 1);
    expect((await getProxyHost(host.id))?.skipAccessLog).toBe(true);
    await updateProxyHost(host.id, { skipAccessLog: false }, 1);
    expect((await getProxyHost(host.id))?.skipAccessLog).toBe(false);
  });
});
