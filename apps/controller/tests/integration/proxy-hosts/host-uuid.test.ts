/** Hosts get a uuid at creation, and a URL or REST path resolves it (or a serial id) back. */
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
  deleteProxyHost,
  getProxyHost,
  resolveProxyHostId,
} from '../../../src/lib/models/proxy-hosts';
import { createL4ProxyHost, resolveL4ProxyHostId } from '../../../src/lib/models/l4-proxy-hosts';
import { deletedHostIdForUuid } from '../../../src/lib/host-history';
import * as schema from '../../../src/lib/db/schema';

const NOW = new Date().toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.l4ProxyHosts);
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

describe('HTTP hosts', () => {
  it('gives each host its own uuid', async () => {
    const a = await createProxyHost(
      { name: 'a', domains: ['a.example.com'], upstreams: ['10.0.0.1:80'] },
      1,
    );
    const b = await createProxyHost(
      { name: 'b', domains: ['b.example.com'], upstreams: ['10.0.0.2:80'] },
      1,
    );
    expect(a.uuid).toMatch(UUID);
    expect(b.uuid).toMatch(UUID);
    expect(a.uuid).not.toBe(b.uuid);
    expect((await getProxyHost(a.id))?.uuid).toBe(a.uuid);
  });

  it('resolves a uuid, in any case, but not a serial id', async () => {
    const host = await createProxyHost(
      { name: 'a', domains: ['a.example.com'], upstreams: ['10.0.0.1:80'] },
      1,
    );
    expect(await resolveProxyHostId(host.uuid)).toBe(host.id);
    expect(await resolveProxyHostId(host.uuid.toUpperCase())).toBe(host.id);
    expect(await resolveProxyHostId(String(host.id))).toBeNull();
  });

  it('resolves nothing for an unknown uuid or a malformed ref', async () => {
    expect(await resolveProxyHostId('0198c2a4-1b2c-7d3e-8f4a-5b6c7d8e9f01')).toBeNull();
    expect(await resolveProxyHostId('12abc')).toBeNull();
  });
});

describe('a deleted host', () => {
  it('is found again by the uuid its last snapshot carries', async () => {
    const host = await createProxyHost(
      { name: 'gone', domains: ['gone.example.com'], upstreams: ['10.0.0.3:80'] },
      1,
    );
    await deleteProxyHost(host.id, 1);
    expect(await resolveProxyHostId(host.uuid)).toBeNull();
    expect(await deletedHostIdForUuid('http', host.uuid)).toBe(host.id);
    expect(await deletedHostIdForUuid('l4', host.uuid)).toBeNull();
  });
});

describe('L4 hosts', () => {
  it('resolves by uuid, not by serial id', async () => {
    const host = await createL4ProxyHost(
      { name: 'l4', protocol: 'tcp', listenAddress: ':5432', upstreams: ['10.0.0.9:5432'] },
      1,
    );
    expect(host.uuid).toMatch(UUID);
    expect(await resolveL4ProxyHostId(host.uuid)).toBe(host.id);
    expect(await resolveL4ProxyHostId(String(host.id))).toBeNull();
    expect(await resolveL4ProxyHostId('0198c2a4-1b2c-7d3e-8f4a-5b6c7d8e9f01')).toBeNull();
  });
});
