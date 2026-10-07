/**
 * The proxy host dashboard actions end to end: the real role guards over a session for a seeded
 * user, real group grants, the form parsed into what the model stores, one audit event
 * per change and the config applied to Caddy. Creating stays with admins; an operator manages only
 * what a grant names.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock, testTranslator } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '../../helpers/db';
import { type FakeCaddy, installFakeCaddy } from '../../helpers/caddy-admin';

let db: TestDb;
/** Whose session setup.bun.ts's auth() mock returns; the role is read from their row. */
let sessionUserId: number | null = null;

vi.mock('../../../src/lib/db', () => dbModuleMock(() => db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { desc, eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/db/schema';
import { auth } from '../../../src/lib/auth';
import { logAuditEvent } from '../../../src/lib/audit';
import { auditEvents } from '../../helpers/audit-events';
import { MAX_BODY_LIMIT_MIB, MIN_BODY_LIMIT_MIB } from '../../../src/lib/waf/caddy';
import { agentIdsForHost } from '../../../src/lib/models/host-agents';
import { getForwardAuthAccessForHost } from '../../../src/lib/models/forward-auth';
import { getProxyHost } from '../../../src/lib/models/proxy-hosts';
import { saveCloudflareSettings } from '../../../src/lib/settings';

const {
  createProxyHostAction,
  deleteProxyHostAction,
  setProxyHostMaintenanceAction,
  toggleProxyHostAction,
  updateProxyHostAction,
} = await import('../../../src/app/(dashboard)/proxy-hosts/actions');

vi.mocked(auth).mockImplementation(async () => {
  if (sessionUserId === null) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, sessionUserId));
  return { user: { id: String(user.id), email: user.email, name: user.name, role: user.role } };
});

const t = testTranslator();
const tHosts = testTranslator('proxyHosts');
const audit = logAuditEvent as unknown as ReturnType<typeof vi.fn>;
const now = () => new Date().toISOString();

let caddy: FakeCaddy;
const users = { admin: 0, operator: 0, viewer: 0 };

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

/** The operator's only group, granting `capability` on each host. */
async function grant(hostId: number, capability: 'view' | 'manage') {
  let [group] = await db.select().from(schema.groups);
  if (!group) {
    [group] = await db
      .insert(schema.groups)
      .values({ name: 'ops', createdAt: now(), updatedAt: now() })
      .returning();
    await db
      .insert(schema.groupMembers)
      .values({ groupId: group.id, userId: users.operator, createdAt: now() });
  }
  await db
    .insert(schema.groupGrants)
    .values({ groupId: group.id, proxyHostId: hostId, capability, createdAt: now() });
}

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

const BASIC = { name: 'app', domains: 'app.example.com', upstreams: 'app:8080' };

/** Created as the admin, then audit and Caddy start clean for the test's own assertions. */
async function seedHost(entries: Record<string, string | string[]> = BASIC) {
  const previous = sessionUserId;
  sessionUserId = users.admin;
  const result = await createProxyHostAction(undefined, form(entries));
  expect(result.status).toBe('success');
  sessionUserId = previous;
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

const hostRows = () => db.select().from(schema.proxyHosts);
const logged = auditEvents(() => db);
const auditCalls = () => logged.list();

function loadedDomains(): string[] {
  return JSON.stringify(caddy.lastConfig() ?? {}).match(/[a-z0-9-]+\.example\.com/g) ?? [];
}

beforeEach(async () => {
  db = await createTestDb();
  caddy = installFakeCaddy();
  audit.mockClear();
  logged.reset();
  users.admin = await insertUser('admin');
  users.operator = await insertUser('operator');
  users.viewer = await insertUser('viewer');
  sessionUserId = users.admin;
});

describe('createProxyHostAction', () => {
  it('stores the host with the model defaults, audits it and applies it', async () => {
    const result = await createProxyHostAction(
      undefined,
      form({
        ...BASIC,
        domains: 'App.Example.com, www.example.com',
        upstreams: 'app:8080\napp:8081',
        description: 'The app',
        enabled: 'on',
      }),
    );

    expect(result).toEqual({ status: 'success', message: tHosts('hostCreated') });
    const [row] = await hostRows();
    expect(row).toMatchObject({
      name: 'app',
      description: 'The app',
      ownerUserId: users.admin,
      certificateId: null,
      accessListId: null,
      enabled: true,
      // No marker was submitted, so the model's defaults hold.
      sslForced: true,
      hstsEnabled: true,
      allowWebsocket: true,
      preserveHostHeader: true,
      hstsSubdomains: false,
    });
    const host = await getProxyHost(row.id);
    expect(host?.domains).toEqual(['app.example.com', 'www.example.com']);
    expect(host?.upstreams).toEqual(['app:8080', 'app:8081']);

    expect(await auditCalls()).toEqual([
      expect.objectContaining({
        userId: users.admin,
        action: 'create',
        entityType: 'proxy_host',
        entityId: row.id,
        summary: 'Created proxy host app',
      }),
    ]);
    expect(caddy.loads).toHaveLength(1);
    expect(loadedDomains()).toContain('app.example.com');
  });

  it('turns defaulted options off when their markers come without a value', async () => {
    await createProxyHostAction(
      undefined,
      form({
        ...BASIC,
        sslForcedPresent: '1',
        hstsEnabledPresent: '1',
        allowWebsocketPresent: '1',
        preserveHostHeaderPresent: '1',
        hstsSubdomains: 'on',
        skipHttpsHostnameValidation: 'on',
      }),
    );
    const [row] = await hostRows();
    expect(row).toMatchObject({
      sslForced: false,
      hstsEnabled: false,
      allowWebsocket: false,
      preserveHostHeader: false,
      hstsSubdomains: true,
      skipHttpsHostnameValidation: true,
      // An unchecked enable box on create submits nothing.
      enabled: false,
    });
  });

  it('round-trips every option group through the model', async () => {
    await createProxyHostAction(
      undefined,
      form({
        ...BASIC,
        lbPresent: '1',
        lbEnabledPresent: '1',
        lbEnabled: 'on',
        lbPolicy: 'weighted_round_robin',
        lbPolicyWeights: '3',
        lbTryDuration: '5s',
        lbPassiveHealthEnabledPresent: '1',
        lbPassiveHealthEnabled: 'on',
        lbPassiveHealthMaxFails: '4',
        dnsPresent: '1',
        dnsEnabledPresent: '1',
        dnsEnabled: 'on',
        dnsResolvers: '1.1.1.1\n9.9.9.9',
        upstreamDnsResolutionPresent: '1',
        upstreamDnsResolutionMode: 'enabled',
        upstreamDnsResolutionFamily: 'ipv4',
        geoblockPresent: '1',
        geoblockEnabled: 'on',
        geoblockMode: 'override',
        geoblockBlockCountries: 'RU',
        redirectsJson: JSON.stringify([{ from: '/old', to: '/new', status: 301 }]),
        rewritePathPrefix: '/app',
        pathBlocksJson: JSON.stringify([{ path: '/admin', status: 403 }]),
        pathRewritesJson: JSON.stringify([{ from: '/s', to: '/dns-query' }]),
        errorPagesJson: JSON.stringify([{ statuses: [502], body: 'down' }]),
        cachePresent: '1',
        cacheEnabled: 'on',
        cacheMode: 'caddy',
        cacheMaxAge: '600',
        compression: 'off',
        maintenancePresent: '1',
        maintenanceBypass: '10.0.0.0/8',
        maintenanceRetryAfter: '60',
        upstreamTimeoutsPresent: '1',
        upstreamTimeoutsEnabled: 'on',
        'upstreamTimeouts.dialTimeout': '3s',
        crowdsecPresent: '1',
        discourageIndexingPresent: '1',
        discourageIndexing: 'on',
      }),
    );

    const [row] = await hostRows();
    const host = await getProxyHost(row.id);
    expect(host?.loadBalancer).toMatchObject({
      enabled: true,
      policy: 'weighted_round_robin',
      policyWeights: [3],
      tryDuration: '5s',
      passiveHealthCheck: { enabled: true, maxFails: 4 },
    });
    expect(host?.dnsResolver).toMatchObject({ enabled: true, resolvers: ['1.1.1.1', '9.9.9.9'] });
    expect(host?.upstreamDnsResolution).toMatchObject({ enabled: true, family: 'ipv4' });
    expect(host?.geoblockMode).toBe('override');
    expect(host?.geoblock).toMatchObject({ enabled: true, block_countries: ['RU'] });
    expect(host?.redirects).toEqual([{ from: '/old', to: '/new', status: 301 }]);
    expect(host?.rewrite).toEqual({ path_prefix: '/app' });
    expect(host?.pathBlocks).toEqual([{ path: '/admin', status: 403 }]);
    expect(host?.pathRewrites).toEqual([{ from: '/s', to: '/dns-query' }]);
    expect(host?.errorPages).toMatchObject([{ statuses: [502], body: 'down' }]);
    expect(host?.cache).toEqual({ mode: 'caddy', maxAge: 600 });
    expect(host?.compression).toBe('off');
    expect(host?.maintenance).toMatchObject({
      enabled: false,
      retryAfter: 60,
      bypassCidrs: ['10.0.0.0/8'],
    });
    expect(host?.upstreamTimeouts).toMatchObject({ dialTimeout: '3s' });
    expect(host?.crowdsec).toBe(false);
    expect(host?.discourageIndexing).toBe(true);
  });

  it('falls back to automatic TLS for a certificate that no longer exists, and says so', async () => {
    const result = await createProxyHostAction(undefined, form({ ...BASIC, certificateId: '999' }));
    expect(result).toEqual({
      status: 'success',
      message: tHosts('hostCreatedAutoCertNoCloudflare', { id: '999' }),
    });
    expect((await hostRows())[0].certificateId).toBeNull();

    await saveCloudflareSettings({ apiToken: 'cf-token' });
    const withDns = await createProxyHostAction(
      undefined,
      form({ ...BASIC, name: 'dns', domains: 'dns.example.com', certificateId: '998' }),
    );
    expect(withDns.message).toBe(tHosts('hostCreatedAutoCert', { id: '998' }));
  });

  it('keeps a certificate that exists, and pins the host to the chosen agents', async () => {
    const [cert] = await db
      .insert(schema.certificates)
      .values({
        name: 'shared',
        type: 'imported',
        domainNames: JSON.stringify(['app.example.com']),
        autoRenew: false,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
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

    await createProxyHostAction(
      undefined,
      form({ ...BASIC, certificateId: String(cert.id), agentId: String(agent.id) }),
    );

    const [row] = await hostRows();
    expect(row.certificateId).toBe(cert.id);
    expect(await agentIdsForHost('http', row.id)).toEqual([agent.id]);
  });

  it('grants CPM forward auth to the chosen users only while it is on', async () => {
    await createProxyHostAction(
      undefined,
      form({
        ...BASIC,
        cpmForwardAuthPresent: '1',
        cpmForwardAuthEnabledPresent: '1',
        cpmForwardAuthEnabled: 'on',
        cpmFaUserId: [String(users.viewer), '0', 'x'],
      }),
    );
    const [on] = await hostRows();
    expect((await getForwardAuthAccessForHost(on.id)).map((entry) => entry.userId)).toEqual([
      users.viewer,
    ]);

    await createProxyHostAction(
      undefined,
      form({
        ...BASIC,
        name: 'off',
        domains: 'off.example.com',
        cpmFaUserId: String(users.viewer),
      }),
    );
    const off = (await hostRows()).find((row) => row.name === 'off')!;
    expect(await getForwardAuthAccessForHost(off.id)).toEqual([]);
  });

  it.each(['operator', 'viewer'] as const)('refuses a %s, writing nothing', async (role) => {
    sessionUserId = users[role];
    const result = await createProxyHostAction(undefined, form(BASIC));
    expect(result).toEqual({ status: 'error', message: t('errors.adminRequired') });
    expect(await hostRows()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(await auditCalls()).toEqual([]);
    expect(caddy.loads).toEqual([]);
  });

  it.each([
    ['no upstream', { upstreams: '' }, 'errors.upstreamsRequired'],
    [
      'an out-of-range WAF limit',
      { wafPresent: '1', wafEnabled: 'on', wafRequestBodyLimitMb: '0' },
      'errors.hostWafRequestBodyLimitInvalid',
    ],
  ] as const)('refuses %s in the reader language', async (_label, entries, key) => {
    const result = await createProxyHostAction(undefined, form({ ...BASIC, ...entries }));
    expect(result).toEqual({
      status: 'error',
      message: t(key, { min: String(MIN_BODY_LIMIT_MIB), max: String(MAX_BODY_LIMIT_MIB) }),
    });
    expect(await hostRows()).toEqual([]);
    expect(caddy.loads).toEqual([]);
  });

  it('keeps the host but reports it when Caddy refuses the config', async () => {
    caddy.failWith(400, 'bad config');
    const result = await createProxyHostAction(undefined, form(BASIC));
    expect(result.status).toBe('error');
    expect(await hostRows()).toHaveLength(1);
    expect((await auditCalls()).map((event) => event.action)).toEqual(['create']);
  });
});

describe('updateProxyHostAction', () => {
  it('changes only what the form carried', async () => {
    const host = await seedHost({
      ...BASIC,
      redirectsJson: JSON.stringify([{ from: '/a', to: '/b', status: 302 }]),
      maintenancePresent: '1',
      maintenanceBypass: '10.0.0.0/8',
    });

    const result = await updateProxyHostAction(host.id, undefined, form({ name: 'renamed' }));

    expect(result).toEqual({ status: 'success', message: tHosts('hostUpdated') });
    const stored = await getProxyHost(host.id);
    expect(stored).toMatchObject({
      name: 'renamed',
      domains: ['app.example.com'],
      upstreams: ['app:8080'],
      redirects: [{ from: '/a', to: '/b', status: 302 }],
      maintenance: { bypassCidrs: ['10.0.0.0/8'] },
    });
    expect(await auditCalls()).toEqual([
      expect.objectContaining({
        userId: users.admin,
        action: 'update',
        entityType: 'proxy_host',
        entityId: host.id,
        summary: 'Updated proxy host renamed',
      }),
    ]);
    expect(caddy.loads).toHaveLength(1);
  });

  it('clears what a rendered form emptied: access list, agent pins, rule lists, enabled', async () => {
    const [list] = await db
      .insert(schema.accessLists)
      .values({ name: 'staff', createdAt: now(), updatedAt: now() })
      .returning();
    const [agent] = await db
      .insert(schema.agents)
      .values({
        name: 'edge',
        agentId: 'f'.repeat(32),
        secret: 'secret',
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    const host = await seedHost({
      ...BASIC,
      enabled: 'on',
      accessListId: String(list.id),
      agentId: String(agent.id),
      redirectsJson: JSON.stringify([{ from: '/a', to: '/b', status: 302 }]),
    });
    expect(host.accessListId).toBe(list.id);

    await updateProxyHostAction(
      host.id,
      undefined,
      form({
        accessListId: '',
        agentAssignmentPresent: '1',
        redirectsJson: '',
        enabledPresent: '1',
      }),
    );

    const stored = await getProxyHost(host.id);
    expect(stored?.accessListId).toBeNull();
    expect(stored?.redirects).toEqual([]);
    expect(stored?.enabled).toBe(false);
    expect(await agentIdsForHost('http', host.id)).toEqual([]);
    // The domains and upstreams fields were not submitted, so an empty value never reached them.
    expect(stored?.upstreams).toEqual(['app:8080']);
  });

  it('falls back to automatic TLS for a missing certificate and leaves it alone when absent', async () => {
    const [cert] = await db
      .insert(schema.certificates)
      .values({
        name: 'shared',
        type: 'imported',
        domainNames: JSON.stringify(['app.example.com']),
        autoRenew: false,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    const host = await seedHost({ ...BASIC, certificateId: String(cert.id) });

    await updateProxyHostAction(host.id, undefined, form({ name: 'kept' }));
    expect((await getProxyHost(host.id))?.certificateId).toBe(cert.id);

    const result = await updateProxyHostAction(host.id, undefined, form({ certificateId: '4242' }));
    expect(result).toEqual({
      status: 'success',
      message: tHosts('hostUpdatedAutoCertNoCloudflare', { id: '4242' }),
    });
    expect((await getProxyHost(host.id))?.certificateId).toBeNull();
  });

  it('replaces the forward-auth allow list only when that section was rendered', async () => {
    const host = await seedHost({
      ...BASIC,
      cpmForwardAuthPresent: '1',
      cpmForwardAuthEnabledPresent: '1',
      cpmForwardAuthEnabled: 'on',
      cpmFaUserId: String(users.viewer),
    });

    await updateProxyHostAction(host.id, undefined, form({ name: 'renamed' }));
    expect(await getForwardAuthAccessForHost(host.id)).toHaveLength(1);

    await updateProxyHostAction(
      host.id,
      undefined,
      form({ cpmForwardAuthPresent: '1', cpmFaUserId: String(users.operator) }),
    );
    expect((await getForwardAuthAccessForHost(host.id)).map((entry) => entry.userId)).toEqual([
      users.operator,
    ]);
  });

  it('lets an operator edit a host granted to manage, as themselves', async () => {
    const host = await seedHost();
    await grant(host.id, 'manage');
    sessionUserId = users.operator;

    const result = await updateProxyHostAction(host.id, undefined, form({ name: 'ops-edit' }));

    expect(result.status).toBe('success');
    expect((await getProxyHost(host.id))?.name).toBe('ops-edit');
    expect((await auditCalls())[0]).toMatchObject({ userId: users.operator, action: 'update' });
  });

  it('refuses an operator whose grant is view-only, or who has none', async () => {
    const viewOnly = await seedHost();
    const ungranted = await seedHost({ ...BASIC, name: 'other', domains: 'other.example.com' });
    await grant(viewOnly.id, 'view');
    sessionUserId = users.operator;

    for (const id of [viewOnly.id, ungranted.id]) {
      const result = await updateProxyHostAction(id, undefined, form({ name: 'hijacked' }));
      expect(result).toEqual({ status: 'error', message: t('errors.accessDenied') });
    }
    expect((await hostRows()).map((row) => row.name).sort()).toEqual(['app', 'other']);
    expect(audit).not.toHaveBeenCalled();
    expect(await auditCalls()).toEqual([]);
    expect(caddy.loads).toEqual([]);
  });

  it('refuses a viewer before looking at grants', async () => {
    const host = await seedHost();
    sessionUserId = users.viewer;
    const result = await updateProxyHostAction(host.id, undefined, form({ name: 'x' }));
    expect(result).toEqual({ status: 'error', message: t('errors.accessDenied') });
  });

  it("keeps raw Caddy config an admin's, even on a host the operator manages", async () => {
    const host = await seedHost();
    await grant(host.id, 'manage');
    sessionUserId = users.operator;

    const result = await updateProxyHostAction(
      host.id,
      undefined,
      form({ customPreHandlersJson: '[{"handler":"file_server","root":"/"}]' }),
    );

    expect(result).toEqual({ status: 'error', message: t('errors.rawCaddyConfigAdminOnly') });
    expect((await getProxyHost(host.id))?.customPreHandlersJson).toBeNull();
  });

  it('says a host that does not exist was not found', async () => {
    const result = await updateProxyHostAction(4242, undefined, form({ name: 'x' }));
    expect(result).toEqual({ status: 'error', message: t('errors.proxyHostNotFound') });
  });
});

describe('deleteProxyHostAction', () => {
  it('deletes the host, audits it and applies a config without it', async () => {
    const keep = await seedHost({
      ...BASIC,
      name: 'keep',
      domains: 'keep.example.com',
      enabled: 'on',
    });
    const gone = await seedHost();

    const result = await deleteProxyHostAction(gone.id);

    expect(result).toEqual({ status: 'success', message: tHosts('hostDeleted') });
    expect((await hostRows()).map((row) => row.id)).toEqual([keep.id]);
    expect(await auditCalls()).toEqual([
      expect.objectContaining({
        action: 'delete',
        entityId: gone.id,
        summary: 'Deleted proxy host app',
      }),
    ]);
    expect(loadedDomains()).toContain('keep.example.com');
    expect(loadedDomains()).not.toContain('app.example.com');
  });

  it('lets an operator delete a managed host but not a view-only one', async () => {
    const managed = await seedHost();
    const viewOnly = await seedHost({ ...BASIC, name: 'view', domains: 'view.example.com' });
    await grant(managed.id, 'manage');
    await grant(viewOnly.id, 'view');
    sessionUserId = users.operator;

    expect((await deleteProxyHostAction(viewOnly.id)).status).toBe('error');
    expect((await deleteProxyHostAction(managed.id)).status).toBe('success');
    expect((await hostRows()).map((row) => row.id)).toEqual([viewOnly.id]);
  });

  it('says a host that does not exist was not found', async () => {
    expect(await deleteProxyHostAction(4242)).toEqual({
      status: 'error',
      message: t('errors.proxyHostNotFound'),
    });
  });
});

describe('toggleProxyHostAction', () => {
  it('switches the host off and on, applying each time', async () => {
    const host = await seedHost({ ...BASIC, enabled: 'on' });

    expect(await toggleProxyHostAction(host.id, false)).toEqual({
      status: 'success',
      message: tHosts('hostDisabledResult'),
    });
    expect((await getProxyHost(host.id))?.enabled).toBe(false);
    expect(loadedDomains()).not.toContain('app.example.com');

    expect(await toggleProxyHostAction(host.id, true)).toEqual({
      status: 'success',
      message: tHosts('hostEnabledResult'),
    });
    expect((await getProxyHost(host.id))?.enabled).toBe(true);
    expect(loadedDomains()).toContain('app.example.com');
    expect((await auditCalls()).map((event) => event.action)).toEqual(['update', 'update']);
  });

  it('refuses an operator without a manage grant', async () => {
    const host = await seedHost({ ...BASIC, enabled: 'on' });
    await grant(host.id, 'view');
    sessionUserId = users.operator;
    expect((await toggleProxyHostAction(host.id, false)).status).toBe('error');
    expect((await getProxyHost(host.id))?.enabled).toBe(true);
  });
});

describe('setProxyHostMaintenanceAction', () => {
  it('switches maintenance, keeping the bypass ranges, and audits the switch itself', async () => {
    const host = await seedHost({
      ...BASIC,
      maintenancePresent: '1',
      maintenanceBypass: '192.0.2.0/24',
    });

    expect(await setProxyHostMaintenanceAction(host.id, true)).toEqual({
      status: 'success',
      message: tHosts('maintenanceOnResult'),
    });
    expect((await getProxyHost(host.id))?.maintenance).toMatchObject({
      enabled: true,
      bypassCidrs: ['192.0.2.0/24'],
    });
    expect(await auditCalls()).toEqual([
      expect.objectContaining({
        summary: 'Turned on maintenance mode for proxy host app',
        data: { maintenance: { enabled: true } },
      }),
    ]);

    expect(await setProxyHostMaintenanceAction(host.id, false)).toEqual({
      status: 'success',
      message: tHosts('maintenanceOffResult'),
    });
    expect((await getProxyHost(host.id))?.maintenance?.enabled).toBe(false);
    expect(caddy.loads).toHaveLength(2);
  });

  it('refuses a viewer and an operator without a grant', async () => {
    const host = await seedHost();
    for (const role of ['viewer', 'operator'] as const) {
      sessionUserId = users[role];
      expect(await setProxyHostMaintenanceAction(host.id, true)).toEqual({
        status: 'error',
        message: t('errors.accessDenied'),
      });
    }
    expect((await getProxyHost(host.id))?.maintenance?.enabled ?? false).toBe(false);
  });
});
