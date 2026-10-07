/**
 * Host revisions against a real database: one per write on every path, in the write's own
 * transaction; secrets left sealed; retention by count or age, whichever keeps more; rollback and
 * restore as new revisions; missing references and domain conflicts refused; audit events naming
 * their revision.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { auditEvents } from '@/tests/helpers/audit-events';
import { createTestDb, type TestDb } from '../../helpers/db';

let db: TestDb;
vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));

import * as schema from '../../../src/lib/db/schema';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { encryptSecret } from '../../../src/lib/secrets';
import { schema as gqlSchema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import {
  createProxyHost,
  deleteProxyHost,
  getProxyHost,
  setProxyHostMaintenance,
  updateProxyHost,
} from '../../../src/lib/models/proxy-hosts';
import {
  createL4ProxyHost,
  deleteL4ProxyHost,
  getL4ProxyHost,
  updateL4ProxyHost,
} from '../../../src/lib/models/l4-proxy-hosts';
import { bulkUpdateL4ProxyHosts, bulkUpdateProxyHosts } from '../../../src/lib/models/bulk-hosts';
import { createAccessList } from '../../../src/lib/models/access-lists';
import { applyConfigImport, exportConfig } from '../../../src/lib/config-transfer';
import { setSetting } from '../../../src/lib/settings';
import {
  auditRevisionLinks,
  compareHostRevisions,
  getHostRevision,
  listDeletedHosts,
  restoreHost,
  rollbackHost,
  rollbackRevisionFrom,
} from '../../../src/lib/host-history';
import { pruneHostRevisions } from '../../../src/lib/host-history/retention';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';

const NOW = () => new Date().toISOString();
const logged = auditEvents(() => db);
let userId: number;

beforeEach(async () => {
  db = await createTestDb();
  invalidateSettingsCache();
  logged.reset();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: 'admin@test',
      name: 'Admin',
      role: 'admin',
      provider: 'credentials',
      subject: 'admin@test',
      status: 'active',
      createdAt: NOW(),
      updatedAt: NOW(),
    })
    .returning();
  userId = user.id;
});

const revisionsOf = (kind: 'http' | 'l4', hostId: number) =>
  db
    .select()
    .from(schema.hostRevisions)
    .where(eq(schema.hostRevisions.hostId, hostId))
    .orderBy(asc(schema.hostRevisions.id))
    .then((rows) => rows.filter((row) => row.hostKind === kind));

const http = (name: string, extra: Record<string, unknown> = {}) =>
  createProxyHost(
    { name, domains: [`${name}.example.com`], upstreams: ['app:8080'], ...extra },
    userId,
  );

const l4 = (name: string, port: number) =>
  createL4ProxyHost(
    { name, protocol: 'tcp', listenAddress: `:${port}`, upstreams: [`${name}:5432`] },
    userId,
  );

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return undefined;
}

describe('every write path', () => {
  it('records one revision per proxy host write, the snapshot as stored', async () => {
    const host = await http('app');
    await updateProxyHost(host.id, { name: 'renamed', tags: ['web'] }, userId);
    await setProxyHostMaintenance(host.id, true, userId);
    await deleteProxyHost(host.id, userId);

    const revisions = await revisionsOf('http', host.id);
    expect(revisions.map((row) => row.operation)).toEqual([
      'create',
      'update',
      'maintenance',
      'delete',
    ]);
    const snapshots = revisions.map((row) => JSON.parse(row.snapshot));
    expect(snapshots[0].row.name).toBe('app');
    expect(snapshots[1].row.name).toBe('renamed');
    expect(JSON.parse(snapshots[1].row.tags)).toEqual(['web']);
    expect(JSON.parse(snapshots[2].row.meta).maintenance.enabled).toBe(true);
    // The deleted host's last state, which is what restoring it brings back.
    expect(snapshots[3].row.name).toBe('renamed');
    expect(revisions.every((row) => row.userId === userId && row.userName === 'Admin')).toBe(true);
  });

  it('records one revision per L4 host write', async () => {
    const host = await l4('db', 15432);
    await updateL4ProxyHost(host.id, { name: 'database' }, userId);
    await deleteL4ProxyHost(host.id, userId);
    const revisions = await revisionsOf('l4', host.id);
    expect(revisions.map((row) => row.operation)).toEqual(['create', 'update', 'delete']);
    expect(JSON.parse(revisions[1].snapshot).row.name).toBe('database');
  });

  it.each([
    ['enable', {}],
    ['disable', {}],
    ['maintenanceOn', {}],
    ['maintenanceOff', {}],
    ['setAccessList', { accessListId: null }],
    ['setCertificate', { certificateId: null }],
    ['addTag', { tag: 'edge' }],
    ['delete', {}],
  ] as const)('records one revision per host for bulk %s', async (action, extra) => {
    const a = await http('alpha');
    const b = await http('beta');
    await bulkUpdateProxyHosts({ action, ids: [a.id, b.id], ...extra }, userId);
    for (const host of [a, b]) {
      const revisions = await revisionsOf('http', host.id);
      expect(revisions.map((row) => row.operation)).toEqual(['create', 'bulk']);
      expect(JSON.parse(revisions[1].detail ?? '{}').action).toBe(action);
    }
  });

  it.each(['enable', 'disable', 'addTag', 'delete'] as const)(
    'records one revision per L4 host for bulk %s',
    async (action) => {
      const a = await l4('one', 15001);
      const b = await l4('two', 15002);
      await bulkUpdateL4ProxyHosts(
        { action, ids: [a.id, b.id], ...(action === 'addTag' ? { tag: 'db' } : {}) },
        userId,
      );
      for (const host of [a, b]) {
        expect((await revisionsOf('l4', host.id)).map((row) => row.operation)).toEqual([
          'create',
          'bulk',
        ]);
      }
    },
  );

  it('records a tag change as the bulk action it is, naming the tag', async () => {
    const host = await http('tagged');
    await bulkUpdateProxyHosts({ action: 'addTag', ids: [host.id], tag: 'prod' }, userId);
    const [, revision] = await revisionsOf('http', host.id);
    expect(JSON.parse(revision.detail ?? '{}')).toEqual({ action: 'addTag', tag: 'prod' });
    expect(JSON.parse(JSON.parse(revision.snapshot).row.tags)).toEqual(['prod']);
  });

  it('records one revision per host a config import writes', async () => {
    await http('imported');
    await l4('stream', 15003);
    const file = await exportConfig('import passphrase', { sections: ['hosts'] });

    db = await createTestDb();
    const [user] = await db
      .insert(schema.users)
      .values({
        email: 'importer@test',
        role: 'admin',
        provider: 'credentials',
        subject: 'importer',
        status: 'active',
        createdAt: NOW(),
        updatedAt: NOW(),
      })
      .returning();
    await applyConfigImport(file, 'import passphrase', user.id);

    const revisions = await db.select().from(schema.hostRevisions);
    expect(revisions.map((row) => [row.hostKind, row.operation]).sort()).toEqual([
      ['http', 'import'],
      ['l4', 'import'],
    ]);
  });

  it('rolls a revision back with the write that failed', async () => {
    // The pin names no agent, so the insert fails after the host row and before the revision.
    expect(await codeOf(http('orphan', { agentIds: [999_999] }))).toBeDefined();
    expect(await db.select().from(schema.proxyHosts)).toEqual([]);
    expect(await db.select().from(schema.hostRevisions)).toEqual([]);
    expect(await logged.list()).toEqual([]);
  });
});

describe('audit events', () => {
  it('name the revision their write made', async () => {
    const host = await http('app');
    await updateProxyHost(host.id, { name: 'renamed' }, userId);
    const events = await logged.list();
    const revisions = await revisionsOf('http', host.id);
    expect(events.map((event) => event.revisionId)).toEqual(revisions.map((row) => row.id));
  });

  it('link to the history, ready to roll back to the revision before, or to restore', async () => {
    const host = await http('app');
    await updateProxyHost(host.id, { name: 'renamed' }, userId);
    await deleteProxyHost(host.id, userId);
    const [created, updated, deleted] = await revisionsOf('http', host.id);
    const events = (await db.select().from(schema.auditEvents)).map((row) => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      revisionId: JSON.parse(row.data ?? '{}').revisionId ?? null,
    }));
    const links = await auditRevisionLinks(events);
    const byRevision = (id: number) =>
      links.get(events.find((event) => event.revisionId === id)!.id);
    // A create has nothing before it to go back to.
    expect(byRevision(created.id)).toBeUndefined();
    expect(byRevision(updated.id)).toEqual({
      kind: 'rollback',
      href: `/proxy-hosts/${host.id}/history?from=${updated.id}&to=${created.id}`,
    });
    expect(byRevision(deleted.id)).toEqual({
      kind: 'restore',
      href: `/proxy-hosts/${host.id}/history?to=${deleted.id}`,
    });
  });
});

describe('comparing', () => {
  it('diffs two revisions field by field, and the Caddy config with only this host swapped', async () => {
    const host = await http('app');
    await updateProxyHost(host.id, { upstreams: ['app:9090'] }, userId);
    const [first, second] = await revisionsOf('http', host.id);
    const comparison = await compareHostRevisions('http', host.id, first.id, second.id, {
      config: true,
    });
    expect(comparison?.changes.map((change) => change.field)).toEqual(['upstreams']);
    expect(comparison?.config?.unchanged).toBe(false);
    const text = comparison?.config?.lines.map((line) => line.text).join('\n') ?? '';
    expect(text).toContain('app:9090');
    // Backwards is what rolling back would do.
    const back = await compareHostRevisions('http', host.id, second.id, first.id);
    expect(back?.changes[0]).toMatchObject({ before: ['app:9090'], after: ['app:8080'] });
    expect(back?.config).toBeUndefined();
  });

  it('refuses a revision of another host', async () => {
    const a = await http('alpha');
    const b = await http('beta');
    const [ofB] = await revisionsOf('http', b.id);
    expect(await compareHostRevisions('http', a.id, 0, ofB.id)).toBeNull();
  });
});

describe('secrets', () => {
  it('stay sealed in a snapshot, and no API answer decrypts them', async () => {
    const host = await http('app');
    const sealed = encryptSecret('hunter2-plaintext');
    await db
      .update(schema.proxyHosts)
      .set({ meta: JSON.stringify({ custom_pre_handlers_json: sealed }) })
      .where(eq(schema.proxyHosts.id, host.id));
    await setProxyHostMaintenance(host.id, true, userId);
    const revisions = await revisionsOf('http', host.id);
    expect(revisions.at(-1)?.snapshot).toContain(sealed);

    const context: GraphQLContext = {
      viewer: async () => ({ userId, role: 'admin', authMethod: 'bearer' as const }),
      access: async () => ({
        userId,
        role: 'admin',
        isAdmin: true,
        isOperator: false,
        grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
      }),
      rawBody: async () => '',
      request: {} as never,
    };
    const answer = await graphql({
      schema: gqlSchema,
      source: `query ($id: Int!, $host: Int!, $from: Int!, $to: Int!) {
        hostRevision(id: $id) { id host missingReferences { kind id } }
        hostRevisions(kind: "http", hostId: $host) { id host }
        compareHostRevisions(kind: "http", hostId: $host, from: $from, to: $to, config: true) {
          changes config
        }
      }`,
      variableValues: {
        id: revisions.at(-1)!.id,
        host: host.id,
        from: revisions[0].id,
        to: revisions.at(-1)!.id,
      },
      contextValue: context,
    });
    expect(answer.errors).toBeUndefined();
    expect(JSON.stringify(answer.data)).not.toContain('hunter2-plaintext');

    const { GET } = await import('../../../src/app/api/v1/proxy-hosts/[id]/revisions/route');
    expect(GET).toBeDefined();
  });
});

describe('retention', () => {
  async function seedRevisions(hostId: number, ages: number[]) {
    const day = 24 * 60 * 60 * 1000;
    await db.insert(schema.hostRevisions).values(
      ages.map((daysOld) => ({
        hostKind: 'http',
        hostId,
        operation: 'update',
        snapshot: '{"row":{},"agentIds":[]}',
        userId: null,
        createdAt: new Date(Date.now() - daysOld * day).toISOString(),
      })),
    );
  }
  const count = async (hostId: number) => (await revisionsOf('http', hostId)).length;

  it('keeps the latest N however old, and younger ones however many', async () => {
    await setSetting('config:host_history_keep_revisions', '3');
    await setSetting('config:host_history_keep_days', '30');
    invalidateSettingsCache();
    // Oldest first: ids follow insertion, so the last ones are the latest.
    await seedRevisions(1, [400, 300, 200, 100, 90]);
    await pruneHostRevisions('http', [1]);
    expect(await count(1)).toBe(3);

    await seedRevisions(2, [400, 300, 10, 5, 4, 3, 2]);
    await pruneHostRevisions('http', [2]);
    // Five are inside the 30 days, more than the three the count would keep.
    expect(await count(2)).toBe(5);
  });

  it('keeps 100 and a year by default', async () => {
    await seedRevisions(
      3,
      [...Array(120)].map((_, index) => 500 - index),
    );
    await pruneHostRevisions('http', [3]);
    expect(await count(3)).toBe(100);
  });
});

describe('rolling back', () => {
  it('saves a new revision and leaves the old ones as they were', async () => {
    const host = await http('app');
    await updateProxyHost(host.id, { name: 'second' }, userId);
    await updateProxyHost(host.id, { name: 'third' }, userId);
    const before = await revisionsOf('http', host.id);

    await rollbackHost(before[0].id, userId);

    expect((await getProxyHost(host.id))?.name).toBe('app');
    const after = await revisionsOf('http', host.id);
    expect(after.slice(0, 3)).toEqual(before);
    expect(after[3]).toMatchObject({ operation: 'rollback' });
    expect(JSON.parse(after[3].detail ?? '{}')).toEqual({ revision: before[0].id });
    const [event] = (await logged.list()).slice(-1);
    expect(event.summary).toBe(`Rolled back proxy host app to revision ${before[0].id}`);
  });

  it('records an editor save carrying a rollback as one', async () => {
    const host = await http('app');
    await updateProxyHost(host.id, { name: 'second' }, userId);
    const [first] = await revisionsOf('http', host.id);
    await updateProxyHost(host.id, { name: 'app' }, userId, { rollbackFrom: first.id });
    const latest = (await revisionsOf('http', host.id)).at(-1);
    expect(latest?.operation).toBe('rollback');
  });

  it('reports each reference the revision names that is gone, and saves nothing', async () => {
    const host = await http('app');
    const [revision] = await db
      .insert(schema.hostRevisions)
      .values({
        hostKind: 'http',
        hostId: host.id,
        operation: 'update',
        snapshot: JSON.stringify({
          row: {
            name: 'app',
            domains: '["app.example.com"]',
            upstreams: '["app:8080"]',
            certificateId: 9001,
            accessListId: 9002,
            meta: JSON.stringify({ mtls: { enabled: true, ca_certificate_ids: [9004] } }),
          },
          agentIds: [9003],
        }),
        userId,
        createdAt: NOW(),
      })
      .returning();
    const before = await revisionsOf('http', host.id);

    let error: unknown;
    try {
      await rollbackHost(revision.id, userId);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    const refused = error as DomainError;
    expect(refused.code).toBe('hostReferencesMissing');
    expect(refused.params.references).toEqual([
      { code: 'hostReferenceCertificate', params: { id: 9001 } },
      { code: 'hostReferenceAccessList', params: { id: 9002 } },
      { code: 'hostReferenceAgent', params: { id: 9003 } },
      { code: 'hostReferenceCaCertificate', params: { id: 9004 } },
    ]);
    expect(await revisionsOf('http', host.id)).toEqual(before);
    expect((await getProxyHost(host.id))?.name).toBe('app');
  });

  it('finds an access list deleted since the revision', async () => {
    const list = await createAccessList({ name: 'office' }, userId);
    const host = await http('app', { accessListId: list.id });
    await updateProxyHost(host.id, { accessListId: null }, userId);
    await db.delete(schema.accessLists).where(eq(schema.accessLists.id, list.id));
    const [first] = await revisionsOf('http', host.id);
    expect(await codeOf(rollbackHost(first.id, userId))).toBe('hostReferencesMissing');
  });
});

describe('restoring a deleted host', () => {
  it('brings it back under its old id as a new revision', async () => {
    const host = await http('app');
    await deleteProxyHost(host.id, userId);
    const [deleted] = await listDeletedHosts('http');
    expect(deleted).toMatchObject({ hostId: host.id, name: 'app' });

    await restoreHost(deleted.revisionId, userId);

    expect((await getProxyHost(host.id))?.domains).toEqual(['app.example.com']);
    const revisions = await revisionsOf('http', host.id);
    expect(revisions.map((row) => row.operation)).toEqual(['create', 'delete', 'restore']);
    expect(await listDeletedHosts('http')).toEqual([]);
    const [event] = (await logged.list()).slice(-1);
    expect(event).toMatchObject({ action: 'restore', summary: 'Restored proxy host app' });
  });

  it('refuses one whose domain another host now serves', async () => {
    const host = await http('app');
    await deleteProxyHost(host.id, userId);
    await createProxyHost(
      { name: 'usurper', domains: ['APP.example.com'], upstreams: ['other:80'] },
      userId,
    );
    const [deleted] = await listDeletedHosts('http');
    expect(await codeOf(restoreHost(deleted.revisionId, userId))).toBe('hostRestoreDomainConflict');
    expect(await getProxyHost(host.id)).toBeNull();
  });

  it('refuses a live host, and an L4 host whose listener is now taken', async () => {
    const live = await http('live');
    const [created] = await revisionsOf('http', live.id);
    expect(await codeOf(restoreHost(created.id, userId))).toBe('hostRestoreExists');

    const stream = await l4('db', 15432);
    await deleteL4ProxyHost(stream.id, userId);
    await createL4ProxyHost(
      { name: 'range', protocol: 'tcp', listenAddress: ':15430-15435', upstreams: ['db:5432'] },
      userId,
    );
    const [deleted] = await listDeletedHosts('l4');
    expect(await codeOf(restoreHost(deleted.revisionId, userId))).toBe('l4ListenPortInUse');
    expect(await getL4ProxyHost(stream.id)).toBeNull();
  });

  it('refuses missing references unless told to leave them out', async () => {
    const list = await createAccessList({ name: 'office' }, userId);
    const host = await http('app', { accessListId: list.id });
    await deleteProxyHost(host.id, userId);
    await db.delete(schema.accessLists).where(eq(schema.accessLists.id, list.id));
    const [deleted] = await listDeletedHosts('http');

    expect(await codeOf(restoreHost(deleted.revisionId, userId))).toBe('hostReferencesMissing');
    await restoreHost(deleted.revisionId, userId, { dropMissingReferences: true });
    expect((await getProxyHost(host.id))?.accessListId).toBeNull();
    const revision = await getHostRevision(deleted.revisionId);
    expect(revision?.snapshot.row.accessListId).toBe(list.id);
  });
});

describe('the editor and the API', () => {
  it('takes the rollback revision from the form, refusing one of another host', async () => {
    const a = await http('alpha');
    const b = await http('beta');
    const [ofA] = await revisionsOf('http', a.id);
    const form = (value: string) => {
      const data = new FormData();
      data.set('rollbackRevision', value);
      return data;
    };
    expect(await rollbackRevisionFrom(new FormData(), 'http', a.id)).toBeUndefined();
    expect(await rollbackRevisionFrom(form(String(ofA.id)), 'http', a.id)).toBe(ofA.id);
    expect(await codeOf(rollbackRevisionFrom(form(String(ofA.id)), 'http', b.id))).toBe(
      'rollbackRevisionInvalid',
    );
    expect(await codeOf(rollbackRevisionFrom(form(String(ofA.id)), 'l4', a.id))).toBe(
      'rollbackRevisionInvalid',
    );
  });

  it('restores and rolls back over GraphQL', async () => {
    const host = await http('app');
    await updateProxyHost(host.id, { name: 'renamed' }, userId);
    const [first] = await revisionsOf('http', host.id);
    const context: GraphQLContext = {
      viewer: async () => ({ userId, role: 'admin', authMethod: 'bearer' as const }),
      access: async () => ({
        userId,
        role: 'admin',
        isAdmin: true,
        isOperator: false,
        grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
      }),
      rawBody: async () => '',
      request: {} as never,
    };
    const run = (source: string, variableValues: Record<string, unknown>) =>
      graphql({ schema: gqlSchema, source, variableValues, contextValue: context });

    const rolled = await run(
      'mutation ($id: Int!) { rollbackHost(revisionId: $id) { operation detail name } }',
      { id: first.id },
    );
    expect(rolled.errors).toBeUndefined();
    expect(rolled.data?.rollbackHost).toEqual({
      operation: 'rollback',
      detail: { revision: first.id },
      name: 'app',
    });

    await deleteProxyHost(host.id, userId);
    const deleted = await run('{ deletedHosts(kind: "http") { hostId revisionId } }', {});
    const [entry] = (deleted.data?.deletedHosts ?? []) as { revisionId: number }[];
    const restored = await run(
      'mutation ($id: Int!) { restoreHost(revisionId: $id) { operation hostId kind } }',
      { id: entry.revisionId },
    );
    expect(restored.data?.restoreHost).toEqual({
      operation: 'restore',
      hostId: host.id,
      kind: 'http',
    });
  });
});
