/**
 * The L4 host dashboard actions end to end: the real role guards over a session for a seeded user,
 * real group grants, the dialog's form parsed into what the model stores, one audit event per
 * change and the config applied to Caddy. Creating stays with admins.
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
import { agentIdsForHost } from '../../../src/lib/models/host-agents';
import { getL4ProxyHost } from '../../../src/lib/models/l4-proxy-hosts';

const {
  createL4ProxyHostAction,
  deleteL4ProxyHostAction,
  toggleL4ProxyHostAction,
  updateL4ProxyHostAction,
} = await import('../../../src/app/(dashboard)/l4-proxy-hosts/actions');

vi.mocked(auth).mockImplementation(async () => {
  if (sessionUserId === null) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, sessionUserId));
  return { user: { id: String(user.id), email: user.email, name: user.name, role: user.role } };
});

const t = testTranslator();
const tL4 = testTranslator('l4ProxyHosts');
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
    .values({ groupId: group.id, l4ProxyHostId: hostId, capability, createdAt: now() });
}

async function accessList(withIpRule: boolean) {
  const [list] = await db
    .insert(schema.accessLists)
    .values({ name: withIpRule ? 'office' : 'passwords', createdAt: now(), updatedAt: now() })
    .returning();
  if (withIpRule) {
    await db.insert(schema.accessListIpRules).values({
      accessListId: list.id,
      action: 'allow',
      cidr: '10.0.0.0/8',
      sortOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    });
  }
  return list;
}

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

const BASIC = {
  name: 'postgres',
  protocol: 'tcp',
  listenAddress: ':5432',
  upstreams: 'db:5432',
  enabled: 'on',
};

async function seedHost(entries: Record<string, string | string[]> = BASIC) {
  const previous = sessionUserId;
  sessionUserId = users.admin;
  const result = await createL4ProxyHostAction(undefined, form(entries));
  expect(result).toEqual({ status: 'success', message: tL4('hostCreated') });
  sessionUserId = previous;
  const [row] = await db
    .select()
    .from(schema.l4ProxyHosts)
    .orderBy(desc(schema.l4ProxyHosts.id))
    .limit(1);
  audit.mockClear();
  caddy.reset();
  return row;
}

const hostRows = () => db.select().from(schema.l4ProxyHosts);
const auditCalls = () => audit.mock.calls.map(([event]) => event as Record<string, unknown>);
const loaded = () => JSON.stringify(caddy.lastConfig() ?? {});

beforeEach(async () => {
  db = await createTestDb();
  caddy = installFakeCaddy();
  audit.mockClear();
  users.admin = await insertUser('admin');
  users.operator = await insertUser('operator');
  users.viewer = await insertUser('viewer');
  sessionUserId = users.admin;
});

describe('createL4ProxyHostAction', () => {
  it('stores the host, audits it and applies a config that listens on its port', async () => {
    const result = await createL4ProxyHostAction(
      undefined,
      form({ ...BASIC, description: 'Primary DB', upstreams: 'db:5432\ndb:5432\nreplica:5432' }),
    );

    expect(result).toEqual({ status: 'success', message: tL4('hostCreated') });
    const [row] = await hostRows();
    const host = await getL4ProxyHost(row.id);
    expect(host).toMatchObject({
      name: 'postgres',
      description: 'Primary DB',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['db:5432', 'replica:5432'],
      matcherType: 'none',
      matcherValue: [],
      tlsTermination: false,
      proxyProtocolVersion: null,
      proxyProtocolReceive: false,
      accessListId: null,
      enabled: true,
      crowdsec: true,
      upstreamPortMode: 'fixed',
      geoblock: null,
      geoblockMode: 'merge',
    });
    expect(row.ownerUserId).toBe(users.admin);
    expect(auditCalls()).toEqual([
      expect.objectContaining({
        userId: users.admin,
        action: 'create',
        entityType: 'l4_proxy_host',
        entityId: row.id,
        summary: 'Created L4 proxy host postgres',
      }),
    ]);
    expect(caddy.loads).toHaveLength(1);
    expect(loaded()).toContain(':5432');
    expect(loaded()).toContain('replica:5432');
  });

  it('round-trips the matcher, PROXY protocol and every option section', async () => {
    const list = await accessList(true);
    await createL4ProxyHostAction(
      undefined,
      form({
        ...BASIC,
        listenAddress: ':8443',
        upstreams: 'a:443\nb:443',
        matcherType: 'tls_sni',
        matcherValue: 'db.example.com, admin.example.com',
        tlsTermination: 'on',
        proxyProtocolVersion: 'v2',
        proxyProtocolReceive: 'on',
        accessListId: String(list.id),
        lbPresent: '1',
        lbEnabledPresent: '1',
        lbEnabled: 'on',
        lbPolicy: 'weighted_round_robin',
        lbPolicyWeights: '3, 1',
        lbTryDuration: '5s',
        lbTryInterval: '',
        lbActiveHealthEnabledPresent: '1',
        lbActiveHealthEnabled: 'on',
        lbActiveHealthPort: '9000',
        lbActiveHealthInterval: '10s',
        lbPassiveHealthEnabledPresent: '1',
        lbPassiveHealthEnabled: 'on',
        lbPassiveHealthMaxFails: '3',
        dnsPresent: '1',
        dnsEnabledPresent: '1',
        dnsEnabled: 'on',
        dnsResolvers: '1.1.1.1\n8.8.8.8',
        dnsFallbacks: '9.9.9.9',
        dnsTimeout: '2s',
        upstreamDnsResolutionPresent: '1',
        upstreamDnsResolutionMode: 'disabled',
        upstreamDnsResolutionFamily: 'ipv6',
        geoblockPresent: '1',
        geoblockEnabled: 'on',
        geoblockMode: 'override',
        geoblockBlockCountries: 'RU, CN',
        geoblockBlockAsns: '13335, nope',
        geoblockAllowCidrs: '10.0.0.0/8',
        crowdsecPresent: '1',
      }),
    );

    const host = await getL4ProxyHost((await hostRows())[0].id);
    expect(host).toMatchObject({
      matcherType: 'tls_sni',
      matcherValue: ['db.example.com', 'admin.example.com'],
      tlsTermination: true,
      proxyProtocolVersion: 'v2',
      proxyProtocolReceive: true,
      accessListId: list.id,
      crowdsec: false,
      geoblockMode: 'override',
    });
    expect(host?.loadBalancer).toMatchObject({
      enabled: true,
      policy: 'weighted_round_robin',
      policyWeights: [3, 1],
      tryDuration: '5s',
      tryInterval: null,
      activeHealthCheck: { enabled: true, port: 9000, interval: '10s' },
      passiveHealthCheck: { enabled: true, maxFails: 3 },
    });
    expect(host?.dnsResolver).toMatchObject({
      enabled: true,
      resolvers: ['1.1.1.1', '8.8.8.8'],
      fallbacks: ['9.9.9.9'],
      timeout: '2s',
    });
    expect(host?.upstreamDnsResolution).toEqual({ enabled: false, family: 'ipv6' });
    expect(host?.geoblock).toMatchObject({
      enabled: true,
      block_countries: ['RU', 'CN'],
      block_asns: [13335],
      allow_cidrs: ['10.0.0.0/8'],
    });
  });

  it('reads unknown choices as the defaults: TCP, no matcher, no PROXY header', async () => {
    await createL4ProxyHostAction(
      undefined,
      form({
        ...BASIC,
        protocol: ' SCTP ',
        matcherType: 'sni_regex',
        matcherValue: 'ignored.example.com',
        proxyProtocolVersion: 'v3',
      }),
    );
    const host = await getL4ProxyHost((await hostRows())[0].id);
    expect(host).toMatchObject({
      protocol: 'tcp',
      matcherType: 'none',
      matcherValue: [],
      proxyProtocolVersion: null,
    });
  });

  it('gives each upstream the listen port in same-port mode, and keeps UDP', async () => {
    await createL4ProxyHostAction(
      undefined,
      form({
        ...BASIC,
        protocol: 'UDP',
        listenAddress: ':5000-5002',
        upstreams: 'media',
        upstreamPortMode: 'same',
      }),
    );
    const host = await getL4ProxyHost((await hostRows())[0].id);
    expect(host).toMatchObject({ protocol: 'udp', upstreamPortMode: 'same', upstreams: ['media'] });
  });

  it('refuses weights that do not all parse, rather than zeroing a backend', async () => {
    await createL4ProxyHostAction(
      undefined,
      form({
        ...BASIC,
        upstreams: 'a:5432\nb:5432',
        lbPresent: '1',
        lbPolicy: 'weighted_round_robin',
        lbPolicyWeights: '2,x',
      }),
    );
    const host = await getL4ProxyHost((await hostRows())[0].id);
    expect(host?.loadBalancer?.policy).toBe('weighted_round_robin');
    expect(host?.loadBalancer?.policyWeights).toBeNull();
  });

  it.each(['operator', 'viewer'] as const)('refuses a %s, writing nothing', async (role) => {
    sessionUserId = users[role];
    const result = await createL4ProxyHostAction(undefined, form(BASIC));
    expect(result).toEqual({ status: 'error', message: t('errors.adminRequired') });
    expect(await hostRows()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(caddy.loads).toEqual([]);
  });

  it.each([
    ['no listen address', { listenAddress: '  ' }, 'errors.listenAddressRequired', {}],
    ['no upstream', { upstreams: '' }, 'errors.upstreamsRequired', {}],
    ['a malformed upstream', { upstreams: 'db' }, 'errors.l4UpstreamInvalid', { upstream: 'db' }],
    [
      'an SNI matcher with no names',
      { matcherType: 'tls_sni', matcherValue: ' , ' },
      'errors.matcherHostnamesRequired',
      {},
    ],
    [
      'TLS termination over UDP',
      { protocol: 'udp', tlsTermination: 'on' },
      'errors.udpTlsTerminationUnsupported',
      {},
    ],
    ['the dashboard port', { listenAddress: ':443' }, 'errors.l4ListenPortReserved', { port: 443 }],
  ] as const)('refuses %s', async (_label, entries, key, params) => {
    const result = await createL4ProxyHostAction(undefined, form({ ...BASIC, ...entries }));
    expect(result).toEqual({ status: 'error', message: t(key, params) });
    expect(await hostRows()).toEqual([]);
    expect(caddy.loads).toEqual([]);
  });

  it('refuses a port another host holds under a different address, unless disabled', async () => {
    await seedHost();
    const clash = { ...BASIC, name: 'clash', listenAddress: '127.0.0.1:5432' };

    const result = await createL4ProxyHostAction(undefined, form(clash));
    expect(result).toEqual({
      status: 'error',
      message: t('errors.l4ListenPortInUse', { port: 5432 }),
    });

    const { enabled: _enabled, ...disabled } = clash;
    expect((await createL4ProxyHostAction(undefined, form(disabled))).status).toBe('success');
    expect(await hostRows()).toHaveLength(2);
  });

  it('refuses an access list with no IP rules, which would close every connection', async () => {
    const list = await accessList(false);
    const result = await createL4ProxyHostAction(
      undefined,
      form({ ...BASIC, accessListId: String(list.id) }),
    );
    expect(result).toEqual({ status: 'error', message: t('errors.l4AccessListNeedsIpRules') });
  });
});

describe('updateL4ProxyHostAction', () => {
  it('saves the dialog, audits it as the editor and applies it', async () => {
    const host = await seedHost();

    const result = await updateL4ProxyHostAction(
      host.id,
      undefined,
      form({ ...BASIC, name: 'pg', listenAddress: ':6432', upstreams: 'pgbouncer:6432' }),
    );

    expect(result).toEqual({ status: 'success', message: tL4('hostUpdated') });
    expect(await getL4ProxyHost(host.id)).toMatchObject({
      name: 'pg',
      listenAddress: ':6432',
      upstreams: ['pgbouncer:6432'],
      enabled: true,
    });
    expect(auditCalls()).toEqual([
      expect.objectContaining({
        userId: users.admin,
        action: 'update',
        entityType: 'l4_proxy_host',
        entityId: host.id,
        summary: 'Updated L4 proxy host pg',
      }),
    ]);
    expect(loaded()).toContain('pgbouncer:6432');
  });

  it('keeps fields the form left empty, and clears what it emptied on purpose', async () => {
    const list = await accessList(true);
    const [agent] = await db
      .insert(schema.agents)
      .values({
        name: 'edge',
        agentId: 'a'.repeat(32),
        secret: 'secret',
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    const host = await seedHost({
      ...BASIC,
      accessListId: String(list.id),
      agentId: String(agent.id),
      lbPresent: '1',
      lbTryDuration: '5s',
    });
    expect(await agentIdsForHost('l4', host.id)).toEqual([agent.id]);

    await updateL4ProxyHostAction(
      host.id,
      undefined,
      form({
        name: '',
        listenAddress: '',
        upstreams: '',
        accessListId: '',
        agentAssignmentPresent: '1',
        enabledPresent: '1',
        lbPresent: '1',
        lbTryDuration: '',
      }),
    );

    const stored = await getL4ProxyHost(host.id);
    expect(stored).toMatchObject({
      name: 'postgres',
      listenAddress: ':5432',
      upstreams: ['db:5432'],
      accessListId: null,
      enabled: false,
    });
    expect(stored?.loadBalancer).not.toBeNull();
    expect(stored?.loadBalancer?.tryDuration).toBeNull();
    expect(await agentIdsForHost('l4', host.id)).toEqual([]);
  });

  it('leaves every field a partial form omits alone', async () => {
    const tcp = await seedHost({
      ...BASIC,
      listenAddress: ':8443',
      upstreams: 'a:443',
      matcherType: 'tls_sni',
      matcherValue: 'db.example.com',
      tlsTermination: 'on',
      proxyProtocolVersion: 'v2',
      proxyProtocolReceive: 'on',
      geoblockPresent: '1',
      geoblockEnabled: 'on',
      geoblockMode: 'override',
      geoblockBlockCountries: 'RU',
    });
    const udp = await seedHost({ ...BASIC, name: 'dns', protocol: 'udp', listenAddress: ':53' });

    for (const host of [tcp, udp]) {
      const result = await updateL4ProxyHostAction(host.id, undefined, form({ name: 'renamed' }));
      expect(result.status).toBe('success');
    }

    expect(await getL4ProxyHost(tcp.id)).toMatchObject({
      name: 'renamed',
      protocol: 'tcp',
      matcherType: 'tls_sni',
      matcherValue: ['db.example.com'],
      tlsTermination: true,
      proxyProtocolVersion: 'v2',
      proxyProtocolReceive: true,
      geoblock: { enabled: true, block_countries: ['RU'] },
      geoblockMode: 'override',
    });
    expect(await getL4ProxyHost(udp.id)).toMatchObject({ protocol: 'udp', matcherType: 'none' });
  });

  it('clears what the dialog renders switched off or emptied', async () => {
    const host = await seedHost({
      ...BASIC,
      listenAddress: ':8443',
      upstreams: 'a:443',
      matcherType: 'tls_sni',
      matcherValue: 'db.example.com',
      tlsTermination: 'on',
      proxyProtocolVersion: 'v2',
      proxyProtocolReceive: 'on',
    });

    await updateL4ProxyHostAction(
      host.id,
      undefined,
      form({
        protocol: 'udp',
        matcherType: 'none',
        tlsTerminationPresent: '1',
        proxyProtocolVersion: '',
        proxyProtocolReceivePresent: '1',
        geoblockPresent: '1',
      }),
    );

    expect(await getL4ProxyHost(host.id)).toMatchObject({
      protocol: 'udp',
      matcherType: 'none',
      matcherValue: [],
      tlsTermination: false,
      proxyProtocolVersion: null,
      proxyProtocolReceive: false,
      geoblock: null,
    });
  });

  it('lets an operator edit a host granted to manage', async () => {
    const host = await seedHost();
    await grant(host.id, 'manage');
    sessionUserId = users.operator;

    const result = await updateL4ProxyHostAction(
      host.id,
      undefined,
      form({ ...BASIC, name: 'op' }),
    );

    expect(result.status).toBe('success');
    expect((await getL4ProxyHost(host.id))?.name).toBe('op');
    expect(auditCalls()[0]).toMatchObject({ userId: users.operator });
  });

  it('refuses an operator with a view-only grant or none, and a viewer', async () => {
    const viewOnly = await seedHost();
    const ungranted = await seedHost({ ...BASIC, name: 'redis', listenAddress: ':6379' });
    await grant(viewOnly.id, 'view');

    for (const [role, id] of [
      ['operator', viewOnly.id],
      ['operator', ungranted.id],
      ['viewer', viewOnly.id],
    ] as const) {
      sessionUserId = users[role];
      const result = await updateL4ProxyHostAction(id, undefined, form({ ...BASIC, name: 'x' }));
      expect(result).toEqual({ status: 'error', message: t('errors.accessDenied') });
    }
    expect((await hostRows()).map((row) => row.name).sort()).toEqual(['postgres', 'redis']);
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses an operator's upstream on the Caddy admin port", async () => {
    const host = await seedHost();
    await grant(host.id, 'manage');
    sessionUserId = users.operator;
    const result = await updateL4ProxyHostAction(
      host.id,
      undefined,
      form({ ...BASIC, upstreams: 'caddy:2019' }),
    );
    expect(result).toEqual({ status: 'error', message: t('errors.upstreamTargetAdminOnly') });
    expect((await getL4ProxyHost(host.id))?.upstreams).toEqual(['db:5432']);
  });

  it('says a host that does not exist was not found', async () => {
    expect(await updateL4ProxyHostAction(4242, undefined, form(BASIC))).toEqual({
      status: 'error',
      message: t('errors.l4ProxyHostNotFound'),
    });
  });
});

describe('deleteL4ProxyHostAction', () => {
  it('deletes the host, audits it and stops listening on its port', async () => {
    const keep = await seedHost({
      ...BASIC,
      name: 'redis',
      listenAddress: ':6379',
      upstreams: 'redis:6379',
    });
    const gone = await seedHost();

    expect(await deleteL4ProxyHostAction(gone.id)).toEqual({
      status: 'success',
      message: tL4('hostDeleted'),
    });
    expect((await hostRows()).map((row) => row.id)).toEqual([keep.id]);
    expect(auditCalls()).toEqual([
      expect.objectContaining({
        action: 'delete',
        entityType: 'l4_proxy_host',
        entityId: gone.id,
        summary: 'Deleted L4 proxy host postgres',
      }),
    ]);
    expect(loaded()).toContain('redis:6379');
    expect(loaded()).not.toContain('db:5432');
  });

  it('lets an operator delete a managed host but not a view-only one', async () => {
    const managed = await seedHost();
    const viewOnly = await seedHost({ ...BASIC, name: 'redis', listenAddress: ':6379' });
    await grant(managed.id, 'manage');
    await grant(viewOnly.id, 'view');
    sessionUserId = users.operator;

    expect(await deleteL4ProxyHostAction(viewOnly.id)).toEqual({
      status: 'error',
      message: t('errors.accessDenied'),
    });
    expect((await deleteL4ProxyHostAction(managed.id)).status).toBe('success');
    expect((await hostRows()).map((row) => row.id)).toEqual([viewOnly.id]);
  });

  it('says a host that does not exist was not found', async () => {
    expect(await deleteL4ProxyHostAction(4242)).toEqual({
      status: 'error',
      message: t('errors.l4ProxyHostNotFound'),
    });
  });
});

describe('toggleL4ProxyHostAction', () => {
  it('switches the host off and on, applying each time', async () => {
    const host = await seedHost();

    expect(await toggleL4ProxyHostAction(host.id, false)).toEqual({
      status: 'success',
      message: tL4('hostDisabledMessage'),
    });
    expect((await getL4ProxyHost(host.id))?.enabled).toBe(false);
    expect(loaded()).not.toContain('db:5432');

    expect(await toggleL4ProxyHostAction(host.id, true)).toEqual({
      status: 'success',
      message: tL4('hostEnabledMessage'),
    });
    expect(loaded()).toContain('db:5432');
    expect(auditCalls().map((event) => event.action)).toEqual(['update', 'update']);
  });

  it('refuses to switch on a host whose port another host took meanwhile', async () => {
    const host = await seedHost();
    await toggleL4ProxyHostAction(host.id, false);
    await seedHost({ ...BASIC, name: 'squatter', listenAddress: '0.0.0.0:5432' });

    expect(await toggleL4ProxyHostAction(host.id, true)).toEqual({
      status: 'error',
      message: t('errors.l4ListenPortInUse', { port: 5432 }),
    });
    expect((await getL4ProxyHost(host.id))?.enabled).toBe(false);
  });

  it('refuses an operator without a manage grant', async () => {
    const host = await seedHost();
    await grant(host.id, 'view');
    sessionUserId = users.operator;
    expect((await toggleL4ProxyHostAction(host.id, false)).status).toBe('error');
    expect((await getL4ProxyHost(host.id))?.enabled).toBe(true);
  });
});
