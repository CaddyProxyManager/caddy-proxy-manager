/**
 * The editors' review step end to end: the preview actions parse the form the save would, run the
 * save's checks, and answer the diff and impact while storing, auditing and applying nothing. A
 * save carrying the review's undo leaves those fields as stored. GraphQL and REST answer the same.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { accessOf, capabilitiesOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '../../helpers/db';
import { type FakeCaddy, installFakeCaddy } from '../../helpers/caddy-admin';

let db: TestDb;
let sessionUserId: number | null = null;

vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { desc, eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { NextRequest } from 'next/server';
import * as schema from '../../../src/lib/db/schema';
import { auth } from '../../../src/lib/auth';
import { logAuditEvent } from '../../../src/lib/audit';
import { auditEvents } from '../../helpers/audit-events';
import { getProxyHost } from '../../../src/lib/models/proxy-hosts';
import { getL4ProxyHost } from '../../../src/lib/models/l4-proxy-hosts';
import { createAccessList } from '../../../src/lib/models/access-lists';
import { insertPairedAgent } from '../../../src/lib/models/agents';
import { setHostAgents } from '../../../src/lib/models/host-agents';
import { schema as gqlSchema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import type { HostChangePreview, HostPreviewResult } from '../../../src/lib/host-review/types';
import { MASKED_VALUE } from '../../../src/lib/host-review/types';

const { createProxyHostAction, previewProxyHostAction, updateProxyHostAction } = await import(
  '../../../src/app/(dashboard)/proxy-hosts/actions'
);
const { createL4ProxyHostAction, previewL4ProxyHostAction, updateL4ProxyHostAction } = await import(
  '../../../src/app/(dashboard)/l4-proxy-hosts/actions'
);

vi.mocked(auth).mockImplementation(async () => {
  if (sessionUserId === null) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, sessionUserId));
  return { user: { id: String(user.id), email: user.email, name: user.name, role: user.role } };
});

const audit = logAuditEvent as unknown as ReturnType<typeof vi.fn>;
const now = () => new Date().toISOString();
let caddy: FakeCaddy;
const users = { admin: 0, operator: 0 };

async function insertUser(role: string): Promise<number> {
  const [row] = await db
    .insert(schema.users)
    .values({
      email: `${role}@example.com`,
      name: role,
      role,
      provider: 'credentials',
      subject: role,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    })
    .returning();
  return row.id;
}

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

function previewOf(result: HostPreviewResult): HostChangePreview {
  if (!result.ok) throw new Error(result.message);
  return result.preview;
}

const BASIC = { name: 'app', domains: 'app.example.com', upstreams: 'app:8080', enabled: 'on' };

async function seedHost(entries: Record<string, string | string[]> = BASIC) {
  const result = await createProxyHostAction(undefined, form(entries));
  expect(result.status).toBe('success');
  const [row] = await db
    .select()
    .from(schema.proxyHosts)
    .orderBy(desc(schema.proxyHosts.id))
    .limit(1);
  audit.mockClear();
  await logged.clear();
  caddy.reset();
  return row;
}

const logged = auditEvents(() => db);

beforeEach(async () => {
  db = await createTestDb();
  caddy = installFakeCaddy();
  audit.mockClear();
  logged.reset();
  users.admin = await insertUser('admin');
  users.operator = await insertUser('operator');
  sessionUserId = users.admin;
});

describe('previewProxyHostAction', () => {
  it('lists each changed field and stores, audits and applies nothing', async () => {
    const row = await seedHost();
    const before = await getProxyHost(row.id);

    const preview = previewOf(
      await previewProxyHostAction(
        row.id,
        form({
          name: 'app renamed',
          domains: 'app.example.com\nnew.example.com',
          upstreams: 'app:8080',
          sslForcedPresent: '1',
        }),
      ),
    );

    expect(preview.kind).toBe('http');
    expect(preview.hostId).toBe(row.id);
    const byField = Object.fromEntries(preview.changes.map((c) => [c.field, c]));
    expect(byField.name).toMatchObject({ before: 'app', after: 'app renamed', section: 'general' });
    expect(byField.domains).toMatchObject({
      before: ['app.example.com'],
      after: ['app.example.com', 'new.example.com'],
    });
    expect(byField.sslForced).toMatchObject({ before: true, after: false });
    // Sent again unchanged, so not a change.
    expect(byField.upstreams).toBeUndefined();

    expect(preview.impact.reload).toBe(true);
    expect(preview.impact.everyAgent).toBe(true);
    expect(preview.impact.certificates).toEqual([{ domain: 'new.example.com', wildcard: false }]);

    expect(await getProxyHost(row.id)).toEqual(before);
    expect(audit).not.toHaveBeenCalled();
    expect(await logged.list()).toEqual([]);
    expect(caddy.loads).toHaveLength(0);
  });

  it('answers nothing to save for the stored values sent back', async () => {
    const row = await seedHost();
    const preview = previewOf(
      await previewProxyHostAction(row.id, form({ ...BASIC, tagsPresent: '1' })),
    );
    expect(preview.changes).toEqual([]);
    expect(preview.impact.reload).toBe(false);
    expect(preview.impact.agents).toEqual([]);
  });

  it('finds nothing to save for a host stored without the defaults the editor fills in', async () => {
    const row = await seedHost();
    // As the API stores them: no WAF merge mode and no geo-block response of its own.
    await db
      .update(schema.proxyHosts)
      .set({
        meta: JSON.stringify({
          waf: { enabled: true, mode: 'DetectionOnly', load_owasp_crs: true },
          geoblock: {
            enabled: true,
            block_countries: ['CN'],
            block_continents: [],
            block_asns: [],
            block_cidrs: [],
            block_ips: [],
            allow_countries: [],
            allow_continents: [],
            allow_asns: [],
            allow_cidrs: [],
            allow_ips: [],
          },
        }),
      })
      .where(eq(schema.proxyHosts.id, row.id));
    // What the editor posts back for it, untouched.
    const preview = previewOf(
      await previewProxyHostAction(
        row.id,
        form({
          ...BASIC,
          tagsPresent: '1',
          wafPresent: '1',
          wafEnabled: 'on',
          wafMode: 'merge',
          wafEngineMode: 'DetectionOnly',
          wafLoadOwaspCrs: 'on',
          wafCustomDirectives: '',
          wafPresetIds: '[]',
          wafPluginIds: '[]',
          geoblockPresent: '1',
          geoblockEnabled: 'on',
          geoblockMode: 'merge',
          geoblockBlockCountries: 'CN',
          geoblockResponseStatus: '',
          geoblockResponseBody: '',
          geoblockRedirectUrl: '',
        }),
      ),
    );
    expect(preview.changes).toEqual([]);
  });

  it('reloads nothing when only notes and tags change', async () => {
    const row = await seedHost();
    const preview = previewOf(
      await previewProxyHostAction(
        row.id,
        form({ description: 'Runbook in the wiki', tagsPresent: '1', tag: ['prod'] }),
      ),
    );
    expect(preview.changes.map((c) => c.field).sort()).toEqual(['description', 'tags']);
    expect(preview.impact.reload).toBe(false);
  });

  it('warns about a domain another host answers for', async () => {
    await seedHost({ ...BASIC, name: 'other', domains: 'shared.example.com' });
    const row = await seedHost();
    const preview = previewOf(
      await previewProxyHostAction(row.id, form({ domains: 'shared.example.com' })),
    );
    expect(preview.impact.warnings).toContainEqual({
      code: 'domainInUse',
      severity: 'warning',
      values: { domain: 'shared.example.com', host: 'other' },
    });
  });

  it('warns when the save takes the WAF away, and when the host is disabled', async () => {
    const row = await seedHost({ ...BASIC, wafPresent: '1', wafEnabled: 'on', wafMode: 'merge' });
    expect((await getProxyHost(row.id))?.waf?.enabled).toBe(true);

    const preview = previewOf(
      await previewProxyHostAction(row.id, form({ wafPresent: '1', enabledPresent: '1' })),
    );
    expect(preview.impact.warnings).toContainEqual(
      expect.objectContaining({ code: 'protectionRemoved', values: { protection: 'waf' } }),
    );
    expect(preview.impact.warnings).toContainEqual(
      expect.objectContaining({ code: 'hostDisabled' }),
    );
  });

  it('warns about an access list that fails closed', async () => {
    const row = await seedHost();
    const list = await createAccessList(
      {
        name: 'office',
        ipRules: [{ action: 'allow', cidr: '10.0.0.0/8', hostname: null, note: null }],
        failClosed: true,
      },
      users.admin,
    );
    const preview = previewOf(
      await previewProxyHostAction(row.id, form({ accessListId: String(list.id) })),
    );
    expect(preview.changes.find((c) => c.field === 'accessListId')).toMatchObject({
      before: null,
      after: 'office',
    });
    expect(preview.impact.warnings).toContainEqual(
      expect.objectContaining({ code: 'accessListFailClosed', values: { name: 'office' } }),
    );
  });

  it('names only the pinned agents, and says the pinning changed', async () => {
    const edge = await insertPairedAgent({ name: 'edge', agentId: 'edge-1', secret: 's1' });
    await insertPairedAgent({ name: 'core', agentId: 'core-1', secret: 's2' });
    const row = await seedHost();
    await setHostAgents('http', row.id, [edge!.id]);

    const preview = previewOf(
      await previewProxyHostAction(
        row.id,
        form({ name: 'renamed', agentAssignmentPresent: '1', agentId: String(edge!.id) }),
      ),
    );
    expect(preview.impact.pinned).toBe(true);
    expect(preview.impact.pinChanged).toBe(false);
    expect(preview.impact.agents.map((a) => a.name)).toEqual(['edge']);
    // Offline, since no agent holds a stream in a test.
    expect(preview.impact.warnings).toContainEqual(
      expect.objectContaining({ code: 'agentOffline', values: { agent: 'edge' } }),
    );

    const unpinned = previewOf(
      await previewProxyHostAction(row.id, form({ agentAssignmentPresent: '1' })),
    );
    expect(unpinned.impact.pinChanged).toBe(true);
    expect(unpinned.impact.everyAgent).toBe(true);
    expect(unpinned.changes.find((c) => c.field === 'agentIds')).toMatchObject({
      before: ['edge'],
      after: null,
    });
  });

  it('masks a sticky-session cookie secret on both sides', async () => {
    const row = await seedHost();
    const preview = previewOf(
      await previewProxyHostAction(
        row.id,
        form({
          lbPresent: '1',
          lbEnabledPresent: '1',
          lbEnabled: 'on',
          lbPolicy: 'cookie',
          lbPolicyCookieName: 'sticky',
          lbPolicyCookieSecret: 'hunter2-very-secret',
        }),
      ),
    );
    const change = preview.changes.find((c) => c.field === 'loadBalancer');
    expect(change?.masked).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('hunter2-very-secret');
    expect(change?.leaves).toContainEqual(expect.objectContaining({ after: MASKED_VALUE }));
  });

  it('previews a create against the defaults, keeping what it cannot drop', async () => {
    const preview = previewOf(
      await previewProxyHostAction(null, form({ ...BASIC, sslForcedPresent: '1' })),
    );
    expect(preview.hostId).toBeNull();
    const byField = Object.fromEntries(preview.changes.map((c) => [c.field, c]));
    expect(byField.name).toMatchObject({ after: 'app', revertible: false });
    expect(byField.sslForced).toMatchObject({ before: true, after: false, revertible: true });
    expect(preview.impact.certificates).toEqual([{ domain: 'app.example.com', wildcard: false }]);
    expect(await db.select().from(schema.proxyHosts)).toEqual([]);
  });

  it('refuses what the save would refuse, in the same words', async () => {
    const row = await seedHost();
    const result = await previewProxyHostAction(
      row.id,
      form({ upstreams: 'ftp://files.example.com' }),
    );
    expect(result.ok).toBe(false);
  });

  it('leaves creating to administrators, and an update to who may manage the host', async () => {
    const row = await seedHost();
    sessionUserId = users.operator;
    expect((await previewProxyHostAction(null, form(BASIC))).ok).toBe(false);
    expect((await previewProxyHostAction(row.id, form({ name: 'x' }))).ok).toBe(false);
  });

  it('takes an undone field out of both the preview and the save', async () => {
    const row = await seedHost();
    const entries = { name: 'renamed', domains: 'other.example.com', revertField: 'domains' };

    const preview = previewOf(await previewProxyHostAction(row.id, form(entries)));
    expect(preview.changes.map((c) => c.field)).toEqual(['name']);

    expect((await updateProxyHostAction(row.id, undefined, form(entries))).status).toBe('success');
    const host = await getProxyHost(row.id);
    expect(host?.name).toBe('renamed');
    expect(host?.domains).toEqual(['app.example.com']);
  });
});

describe('the audit diff a save records', () => {
  const changesLogged = async () =>
    ((await logged.list()).at(-1)?.changes ?? []) as { field: string }[];

  it('is the field diff the review showed, secrets masked', async () => {
    const row = await seedHost();
    const entries = {
      name: 'app renamed',
      lbPresent: '1',
      lbEnabledPresent: '1',
      lbEnabled: 'on',
      lbPolicy: 'cookie',
      lbPolicyCookieName: 'sticky',
      lbPolicyCookieSecret: 'hunter2-very-secret',
    };
    const preview = previewOf(await previewProxyHostAction(row.id, form(entries)));
    expect((await updateProxyHostAction(row.id, undefined, form(entries))).status).toBe('success');
    const changes = await changesLogged();
    expect(changes.map((c) => c.field)).toEqual(preview.changes.map((c) => c.field));
    expect(JSON.stringify(await logged.list())).not.toContain('hunter2-very-secret');
  });

  it('records nothing changed for a save of the stored values', async () => {
    const row = await seedHost();
    expect((await updateProxyHostAction(row.id, undefined, form({ name: 'app' }))).status).toBe(
      'success',
    );
    expect(await changesLogged()).toEqual([]);
  });

  it('names the access list a create sets, not its id', async () => {
    const list = await createAccessList({ name: 'office' }, users.admin);
    audit.mockClear();
    await logged.clear();
    expect(
      (await createProxyHostAction(undefined, form({ ...BASIC, accessListId: String(list.id) })))
        .status,
    ).toBe('success');
    const created = ((await logged.list()).find((event) => event.action === 'create') ?? {}) as {
      changes?: { field: string; after: unknown }[];
    };
    expect(created.changes?.find((c) => c.field === 'accessListId')?.after).toBe('office');
  });
});

describe('previewL4ProxyHostAction', () => {
  const L4 = {
    name: 'db',
    protocol: 'tcp',
    listenAddress: ':15432',
    upstreams: 'db:5432',
    enabled: 'on',
  };

  async function seedL4(entries: Record<string, string | string[]> = L4) {
    expect((await createL4ProxyHostAction(undefined, form(entries))).status).toBe('success');
    const rows = await db.select().from(schema.l4ProxyHosts);
    audit.mockClear();
    await logged.clear();
    caddy.reset();
    return rows[rows.length - 1];
  }

  it('notes the port apply a new listen address needs, storing nothing', async () => {
    const row = await seedL4();
    const before = await getL4ProxyHost(row.id);
    const preview = previewOf(
      await previewL4ProxyHostAction(row.id, form({ listenAddress: ':15433' })),
    );
    expect(preview.kind).toBe('l4');
    expect(preview.changes).toEqual([
      expect.objectContaining({
        field: 'listenAddress',
        section: 'listener',
        before: ':15432',
        after: ':15433',
      }),
    ]);
    expect(preview.impact.warnings).toContainEqual(
      expect.objectContaining({ code: 'l4PortsApply', values: { listen: ':15433' } }),
    );
    expect(await getL4ProxyHost(row.id)).toEqual(before);
    expect(audit).not.toHaveBeenCalled();
    expect(await logged.list()).toEqual([]);
    expect(caddy.loads).toHaveLength(0);
  });

  it('warns when the access list comes off', async () => {
    const list = await createAccessList(
      {
        name: 'office',
        ipRules: [{ action: 'allow', cidr: '10.0.0.0/8', hostname: null, note: null }],
      },
      users.admin,
    );
    const row = await seedL4({ ...L4, accessListId: String(list.id) });
    const preview = previewOf(
      await previewL4ProxyHostAction(row.id, form({ accessListId: '__none__' })),
    );
    expect(preview.impact.warnings).toContainEqual(
      expect.objectContaining({ code: 'protectionRemoved', values: { protection: 'accessList' } }),
    );
  });

  it('saves without an undone field', async () => {
    const row = await seedL4();
    const entries = { name: 'database', listenAddress: ':15433', revertField: 'listenAddress' };
    expect((await updateL4ProxyHostAction(row.id, undefined, form(entries))).status).toBe(
      'success',
    );
    const host = await getL4ProxyHost(row.id);
    expect(host?.name).toBe('database');
    expect(host?.listenAddress).toBe(':15432');
    const last = (await logged.list()).at(-1) as { changes?: { field: string }[] };
    expect(last.changes?.map((c) => c.field)).toEqual(['name']);
  });
});

describe('the API previews', () => {
  function contextFor(role: string): GraphQLContext {
    return {
      viewer: async () => ({ userId: users.admin, role, authMethod: 'bearer' as const }),
      access: async () => ({
        userId: users.admin,
        role,
        capabilities: capabilitiesOf(role),
        grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
      }),
      rawBody: async () => '',
      request: {} as never,
    };
  }

  it('previewProxyHost answers the diff and stores nothing', async () => {
    const row = await seedHost();
    const result = await graphql({
      schema: gqlSchema,
      source: `mutation ($id: Int, $input: JSON!, $revert: [String!]) {
        previewProxyHost(id: $id, input: $input, revert: $revert) {
          kind hostId changes { field before after section revertible } impact { reload certificates }
        }
      }`,
      contextValue: contextFor('admin'),
      variableValues: {
        id: row.id,
        input: { name: 'renamed', domains: ['app.example.com', 'api.example.com'] },
        revert: ['name'],
      },
    });
    expect(result.errors).toBeUndefined();
    const preview = (result.data as { previewProxyHost: HostChangePreview }).previewProxyHost;
    expect(preview.changes.map((c) => c.field)).toEqual(['domains']);
    expect(preview.impact.certificates).toEqual([{ domain: 'api.example.com', wildcard: false }]);
    expect((await getProxyHost(row.id))?.name).toBe('app');
  });

  it('previewL4ProxyHost refuses a non-admin', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `mutation { previewL4ProxyHost(input: {}) { kind } }`,
      contextValue: contextFor('user'),
    });
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it('POST /api/v1/proxy-hosts/{id}/preview takes ?revert like the editor', async () => {
    const row = await seedHost();
    vi.spyOn(await import('../../../src/lib/api/auth'), 'requireApiUser').mockResolvedValue({
      userId: users.admin,
      role: 'admin',
      authMethod: 'bearer',
      access: accessOf('admin'),
    } as never);
    const { POST } = await import('../../../src/app/api/v1/proxy-hosts/[id]/preview/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/v1/proxy-hosts/${row.uuid}/preview?revert=domains`, {
        method: 'POST',
        body: JSON.stringify({ name: 'renamed', domains: ['x.example.com'] }),
      }),
      { params: Promise.resolve({ id: String(row.uuid) }) },
    );
    expect(response.status).toBe(200);
    const preview = (await response.json()) as HostChangePreview;
    expect(preview.changes.map((c) => c.field)).toEqual(['name']);
    expect((await getProxyHost(row.id))?.name).toBe('app');
  });
});
