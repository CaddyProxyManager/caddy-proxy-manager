/**
 * Integration: bulk host changes against a real database - all or nothing, one audit row per host,
 * exactly one apply - and the dashboard actions' per-id permission check.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { accessOf } from '@/tests/helpers/access';
import { capabilitiesOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '../../helpers/db';

let db: TestDb;

vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));
const applyCaddyConfig = vi.fn(async () => {});
// The GraphQL resolvers reach certificate-files, which needs the per-agent apply too.
vi.mock('../../../src/lib/caddy', () => ({ applyCaddyConfig, applyCaddyConfigToAgent: vi.fn() }));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualPermissions = await import('../../../src/lib/users/permissions');
type Access = Awaited<ReturnType<typeof actualPermissions.requireReach>>;
let access: Access;
vi.mock('../../../src/lib/users/permissions', () => ({
  ...actualPermissions,
  requireReach: async () => access,
}));

import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { emptyGrants } from '../../../src/lib/models/group-grants';

const { bulkUpdateProxyHosts, bulkUpdateL4ProxyHosts, parseProxyHostBulkRequest } = await import(
  '../../../src/lib/models/bulk-hosts'
);
const { bulkProxyHostsAction } = await import('../../../src/app/(dashboard)/proxy-hosts/actions');
const { bulkL4ProxyHostsAction } = await import(
  '../../../src/app/(dashboard)/l4-proxy-hosts/actions'
);
const { resolvers } = await import('../../../src/lib/graphql/resolvers');
const { withRequirements } = await import('../../../src/lib/graphql/token-scope');
const { deleteUnusedCertificates } = await import('../../../src/lib/models/certificates');
const { removeAccessListEntries } = await import('../../../src/lib/models/access-lists');

let userId: number;
const now = () => new Date().toISOString();

beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: 'admin@test',
      name: 'Admin',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@test',
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  userId = user.id;
  access = { userId, role: 'admin', capabilities: capabilitiesOf('admin'), grants: emptyGrants() };
});

async function insertHost(
  name: string,
  overrides: Partial<typeof schema.proxyHosts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.proxyHosts)
    .values({
      name,
      domains: JSON.stringify([`${name}.example.com`]),
      upstreams: JSON.stringify(['app:80']),
      enabled: true,
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .returning();
  return row;
}

async function insertL4Host(name: string) {
  const [row] = await db
    .insert(schema.l4ProxyHosts)
    .values({
      name,
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: JSON.stringify(['db:5432']),
      matcherType: 'none',
      matcherValue: null,
      tlsTermination: false,
      proxyProtocolVersion: null,
      proxyProtocolReceive: false,
      enabled: true,
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  return row;
}

async function insertCertificate(name: string) {
  const [row] = await db
    .insert(schema.certificates)
    .values({
      name,
      type: 'imported',
      domainNames: JSON.stringify(['example.com']),
      autoRenew: false,
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  return row;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return undefined;
}

const hostRows = () => db.select().from(schema.proxyHosts);
const auditRows = () => db.select().from(schema.auditEvents);

describe('bulkUpdateProxyHosts', () => {
  it('disables a batch with one audit row per host and a single apply', async () => {
    const a = await insertHost('alpha');
    const b = await insertHost('beta');
    const c = await insertHost('gamma');

    const result = await bulkUpdateProxyHosts({ action: 'disable', ids: [a.id, b.id] }, userId);
    expect(result.count).toBe(2);
    const rows = await hostRows();
    expect(
      rows
        .filter((r) => !r.enabled)
        .map((r) => r.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(rows.find((r) => r.id === c.id)?.enabled).toBe(true);

    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => row.summary).sort()).toEqual([
      'Updated proxy host alpha',
      'Updated proxy host beta',
    ]);
    expect(JSON.parse(audits[0].data!)).toEqual({
      enabled: false,
      bulk: true,
      revisionId: expect.any(Number),
    });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when one id does not exist', async () => {
    const a = await insertHost('alpha');
    expect(
      await codeOf(bulkUpdateProxyHosts({ action: 'disable', ids: [a.id, 999_999] }, userId)),
    ).toBe('proxyHostNotFound');
    expect((await hostRows())[0].enabled).toBe(true);
    expect(await auditRows()).toHaveLength(0);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('refuses automatic TLS for a wildcard host with no DNS provider, for the whole batch', async () => {
    const cert = await insertCertificate('wild');
    const plain = await insertHost('plain', { certificateId: cert.id });
    const wild = await insertHost('wild', {
      domains: JSON.stringify(['*.example.com']),
      certificateId: cert.id,
    });
    const code = await codeOf(
      bulkUpdateProxyHosts(
        { action: 'setCertificate', ids: [plain.id, wild.id], certificateId: null },
        userId,
      ),
    );
    expect(code).toBe('wildcardDomainNeedsDnsProvider');
    expect((await hostRows()).every((r) => r.certificateId === cert.id)).toBe(true);
  });

  it('sets a certificate and an access list, and refuses ones that do not exist', async () => {
    const a = await insertHost('alpha');
    const cert = await insertCertificate('shared');
    const [list] = await db
      .insert(schema.accessLists)
      .values({ name: 'staff', createdAt: now(), updatedAt: now() })
      .returning();

    await bulkUpdateProxyHosts(
      { action: 'setCertificate', ids: [a.id], certificateId: cert.id },
      userId,
    );
    await bulkUpdateProxyHosts(
      { action: 'setAccessList', ids: [a.id], accessListId: list.id },
      userId,
    );
    const [row] = await hostRows();
    expect(row.certificateId).toBe(cert.id);
    expect(row.accessListId).toBe(list.id);

    expect(
      await codeOf(
        bulkUpdateProxyHosts({ action: 'setCertificate', ids: [a.id], certificateId: 999 }, userId),
      ),
    ).toBe('certificateNotFound');
    expect(
      await codeOf(
        bulkUpdateProxyHosts({ action: 'setAccessList', ids: [a.id], accessListId: 999 }, userId),
      ),
    ).toBe('accessListNotFound');
  });

  it('sets a file certificate only on hosts pinned to its agent alone', async () => {
    const [agent] = await db
      .insert(schema.agents)
      .values({
        name: 'edge',
        agentId: 'e'.repeat(32),
        secret: 'secret',
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    const [cert] = await db
      .insert(schema.certificates)
      .values({
        name: 'from-files',
        type: 'imported',
        domainNames: JSON.stringify(['example.com']),
        autoRenew: false,
        source: 'agent-file',
        sourceAgentId: agent.id,
        sourceCertPath: 'live/example.com/fullchain.pem',
        sourceKeyPath: 'live/example.com/privkey.pem',
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    const pinned = await insertHost('pinned');
    const unpinned = await insertHost('unpinned');
    await db
      .insert(schema.proxyHostAgents)
      .values({ proxyHostId: pinned.id, agentId: agent.id, createdAt: now() });
    const request = (ids: number[]) =>
      bulkUpdateProxyHosts({ action: 'setCertificate', ids, certificateId: cert.id }, userId);

    // One unpinned host refuses the whole batch.
    expect(await codeOf(request([pinned.id, unpinned.id]))).toBe('certificateFileAgentOnly');
    expect((await hostRows()).every((row) => row.certificateId === null)).toBe(true);

    await request([pinned.id]);
    const byId = new Map((await hostRows()).map((row) => [row.id, row]));
    expect(byId.get(pinned.id)?.certificateId).toBe(cert.id);
  });

  it('switches maintenance per host, keeping each host its own bypass ranges', async () => {
    const a = await insertHost('alpha', {
      meta: JSON.stringify({ maintenance: { enabled: false, bypass_cidrs: ['10.0.0.0/8'] } }),
    });
    const b = await insertHost('beta');
    await bulkUpdateProxyHosts({ action: 'maintenanceOn', ids: [a.id, b.id] }, userId);
    const rows = await hostRows();
    const metaOf = (id: number) => JSON.parse(rows.find((r) => r.id === id)!.meta ?? '{}');
    expect(metaOf(a.id).maintenance.enabled).toBe(true);
    expect(metaOf(a.id).maintenance.bypass_cidrs).toEqual(['10.0.0.0/8']);
    expect(metaOf(b.id).maintenance.enabled).toBe(true);
    const audits = await auditRows();
    expect(audits.map((row) => row.summary).sort()).toEqual([
      'Turned on maintenance mode for proxy host alpha',
      'Turned on maintenance mode for proxy host beta',
    ]);
  });

  it('deletes a batch, taking agent pins with it as a single delete does', async () => {
    const a = await insertHost('alpha');
    const b = await insertHost('beta');
    const [agent] = await db
      .insert(schema.agents)
      .values({ name: 'edge', agentId: 'edge', secret: 'x', createdAt: now(), updatedAt: now() })
      .returning();
    await db
      .insert(schema.proxyHostAgents)
      .values({ proxyHostId: a.id, agentId: agent.id, createdAt: now() });

    await bulkUpdateProxyHosts({ action: 'delete', ids: [a.id, b.id] }, userId);
    expect(await hostRows()).toHaveLength(0);
    expect(await db.select().from(schema.proxyHostAgents)).toHaveLength(0);
    const audits = await auditRows();
    expect(audits.every((row) => row.action === 'delete')).toBe(true);
    expect(audits).toHaveLength(2);
  });

  it('refuses a malformed or oversized request', () => {
    expect(() => parseProxyHostBulkRequest({ action: 'explode', ids: [1] })).toThrow();
    expect(() => parseProxyHostBulkRequest({ action: 'enable', ids: [] })).toThrow();
    expect(() => parseProxyHostBulkRequest({ action: 'enable', ids: ['1'] })).toThrow();
    expect(() => parseProxyHostBulkRequest({ action: 'setCertificate', ids: [1] })).toThrow();
    expect(() =>
      parseProxyHostBulkRequest({
        action: 'enable',
        ids: Array.from({ length: 501 }, (_, i) => i + 1),
      }),
    ).toThrow();
    expect(parseProxyHostBulkRequest({ action: 'enable', ids: [2, 2, 3] }).ids).toEqual([2, 3]);
  });
});

describe('bulkProxyHostsAction', () => {
  it('refuses the whole batch when an operator may only view one host', async () => {
    const managed = await insertHost('managed');
    const viewOnly = await insertHost('view-only');
    const grants = emptyGrants();
    grants.proxyHosts.set(managed.id, 'manage');
    grants.proxyHosts.set(viewOnly.id, 'view');
    access = { userId, role: 'operator', capabilities: capabilitiesOf('operator'), grants };

    const result = await bulkProxyHostsAction({
      action: 'disable',
      ids: [managed.id, viewOnly.id],
    });
    expect(result.status).toBe('error');
    expect((await hostRows()).every((r) => r.enabled)).toBe(true);
    expect(applyCaddyConfig).not.toHaveBeenCalled();

    const allowed = await bulkProxyHostsAction({ action: 'disable', ids: [managed.id] });
    expect(allowed.status).toBe('success');
    const rows = await hostRows();
    expect(rows.find((r) => r.id === managed.id)?.enabled).toBe(false);
  });
});

describe('operators with mixed grants', () => {
  function operator(proxy: [number, 'view' | 'manage'][], l4: [number, 'view' | 'manage'][] = []) {
    const grants = emptyGrants();
    for (const [id, level] of proxy) grants.proxyHosts.set(id, level);
    for (const [id, level] of l4) grants.l4ProxyHosts.set(id, level);
    access = { userId, role: 'operator', capabilities: capabilitiesOf('operator'), grants };
  }

  it('refuses a delete, a certificate or maintenance when one host is not theirs at all', async () => {
    const managed = await insertHost('managed');
    const stranger = await insertHost('stranger');
    const cert = await insertCertificate('cert');
    operator([[managed.id, 'manage']]);

    for (const request of [
      { action: 'delete', ids: [managed.id, stranger.id] },
      { action: 'setCertificate', ids: [managed.id, stranger.id], certificateId: cert.id },
      { action: 'maintenanceOn', ids: [managed.id, stranger.id] },
    ]) {
      const result = await bulkProxyHostsAction(request as never);
      expect(result).toMatchObject({ status: 'error', message: 'You do not have access to that.' });
    }
    const rows = await hostRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.certificateId === null)).toBe(true);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses an L4 batch with a view-only host, and allows the managed ones alone', async () => {
    const managed = await insertL4Host('pg');
    const viewOnly = await insertL4Host('redis');
    operator(
      [],
      [
        [managed.id, 'manage'],
        [viewOnly.id, 'view'],
      ],
    );

    const refused = await bulkL4ProxyHostsAction({
      action: 'delete',
      ids: [managed.id, viewOnly.id],
    });
    expect(refused).toMatchObject({ status: 'error', message: 'You do not have access to that.' });
    expect(await db.select().from(schema.l4ProxyHosts)).toHaveLength(2);

    const allowed = await bulkL4ProxyHostsAction({ action: 'disable', ids: [managed.id] });
    expect(allowed.status).toBe('success');
    const rows = await db.select().from(schema.l4ProxyHosts);
    expect(rows.find((r) => r.id === managed.id)?.enabled).toBe(false);
    expect(rows.find((r) => r.id === viewOnly.id)?.enabled).toBe(true);
  });

  it('keeps the GraphQL bulk mutations to administrators, whatever the grants', async () => {
    const host = await insertHost('managed');
    const l4 = await insertL4Host('pg');
    const context = {
      viewer: async () => ({ userId, role: 'operator' }),
      access: async () => accessOf('operator', { proxyHosts: new Map([[host.id, 'manage']]) }),
    } as never;
    // As served: the role check is the wrapper's, not each resolver's.
    const served = withRequirements('Mutation', resolvers.Mutation);

    await expect(
      served.bulkProxyHosts(null, { input: { action: 'disable', ids: [host.id] } }, context),
    ).rejects.toThrow();
    await expect(
      served.bulkL4ProxyHosts(null, { input: { action: 'disable', ids: [l4.id] } }, context),
    ).rejects.toThrow();
    expect((await hostRows())[0].enabled).toBe(true);
    expect((await db.select().from(schema.l4ProxyHosts))[0].enabled).toBe(true);
  });
});

describe('bulkUpdateL4ProxyHosts', () => {
  it('disables and deletes with one apply each', async () => {
    const a = await insertL4Host('pg');
    const b = await insertL4Host('redis');
    await bulkUpdateL4ProxyHosts({ action: 'disable', ids: [a.id, b.id] }, userId);
    expect((await db.select().from(schema.l4ProxyHosts)).every((r) => !r.enabled)).toBe(true);
    await bulkUpdateL4ProxyHosts({ action: 'delete', ids: [a.id, b.id] }, userId);
    expect(await db.select().from(schema.l4ProxyHosts)).toHaveLength(0);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(2);
    expect(await auditRows()).toHaveLength(4);
  });

  it('writes nothing when one id does not exist', async () => {
    const a = await insertL4Host('pg');
    expect(
      await codeOf(bulkUpdateL4ProxyHosts({ action: 'delete', ids: [a.id, 424_242] }, userId)),
    ).toBe('l4ProxyHostNotFound');
    expect(await db.select().from(schema.l4ProxyHosts)).toHaveLength(1);
  });

  it('refuses enabling hosts whose ports clash, with each other or an enabled one', async () => {
    const enabled = await insertL4Host('pg');
    const clash = await insertL4Host('range');
    const other = await insertL4Host('other');
    await db
      .update(schema.l4ProxyHosts)
      .set({ enabled: false, listenAddress: ':5400-5500' })
      .where(eq(schema.l4ProxyHosts.id, clash.id));
    await db
      .update(schema.l4ProxyHosts)
      .set({ enabled: false, listenAddress: ':6000' })
      .where(eq(schema.l4ProxyHosts.id, other.id));

    // :5432 and :5400-5500 are different listen strings over one port.
    expect(
      await codeOf(bulkUpdateL4ProxyHosts({ action: 'enable', ids: [clash.id, other.id] }, userId)),
    ).toBe('l4ListenPortInUse');
    expect(
      (await db.select().from(schema.l4ProxyHosts)).filter((r) => r.enabled).map((r) => r.id),
    ).toEqual([enabled.id]);

    await bulkUpdateL4ProxyHosts({ action: 'disable', ids: [enabled.id] }, userId);
    await db
      .update(schema.l4ProxyHosts)
      .set({ listenAddress: '0.0.0.0:6000' })
      .where(eq(schema.l4ProxyHosts.id, enabled.id));
    expect(
      await codeOf(
        bulkUpdateL4ProxyHosts({ action: 'enable', ids: [enabled.id, other.id] }, userId),
      ),
    ).toBe('l4ListenPortInUse');

    await bulkUpdateL4ProxyHosts({ action: 'enable', ids: [clash.id, other.id] }, userId);
    expect(
      (await db.select().from(schema.l4ProxyHosts))
        .filter((r) => r.enabled)
        .map((r) => r.id)
        .sort(),
    ).toEqual([clash.id, other.id].sort());
  });
});

describe('deleteUnusedCertificates', () => {
  it('deletes the unused ones, and refuses the batch once a host has taken one', async () => {
    const a = await insertCertificate('a');
    const b = await insertCertificate('b');
    await deleteUnusedCertificates([a.id], userId);
    expect((await db.select().from(schema.certificates)).map((c) => c.id)).toEqual([b.id]);

    const c = await insertCertificate('c');
    await insertHost('alpha', { certificateId: b.id });
    expect(await codeOf(deleteUnusedCertificates([b.id, c.id], userId))).toBe(
      'certificateInUseByHosts',
    );
    expect(await db.select().from(schema.certificates)).toHaveLength(2);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
  });
});

describe('removeAccessListEntries', () => {
  it('removes several entries with one apply, and none when one belongs elsewhere', async () => {
    const [list] = await db
      .insert(schema.accessLists)
      .values({ name: 'staff', createdAt: now(), updatedAt: now() })
      .returning();
    const [other] = await db
      .insert(schema.accessLists)
      .values({ name: 'other', createdAt: now(), updatedAt: now() })
      .returning();
    const entry = async (accessListId: number, username: string) =>
      (
        await db
          .insert(schema.accessListEntries)
          .values({ accessListId, username, passwordHash: 'x', createdAt: now(), updatedAt: now() })
          .returning()
      )[0];
    const e1 = await entry(list.id, 'a');
    const e2 = await entry(list.id, 'b');
    const foreign = await entry(other.id, 'c');

    expect(await codeOf(removeAccessListEntries(list.id, [e1.id, foreign.id], userId))).toBe(
      'accessListEntryNotFound',
    );
    expect(await db.select().from(schema.accessListEntries)).toHaveLength(3);

    await removeAccessListEntries(list.id, [e1.id, e2.id], userId);
    const left = await db.select().from(schema.accessListEntries);
    expect(left.map((row) => row.id)).toEqual([foreign.id]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(
      (await auditRows()).filter((row) => row.entityType === 'access_list_entry'),
    ).toHaveLength(2);
  });
});
