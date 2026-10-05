/**
 * The Needs attention providers against a real database: what each reads, and what an operator
 * gets of it. Agents, ClickHouse and LDAP are absent here, so their providers answer nothing.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createSelfSignedServerCertificate } from '@/tests/helpers/certs';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const schema = await import('../../../src/lib/db/schema');
const { collectAttention } = await import('../../../src/lib/attention');
const { ATTENTION_PROVIDER_LIST } = await import('../../../src/lib/attention/providers');
const { recordApplyFailure, recordApplySuccess, getApplyFailures } = await import(
  '../../../src/lib/caddy/apply-status'
);
const { CaddyApplyError } = await import('../../../src/lib/caddy/apply-error');
const { setCrsPluginQuarantine } = await import('../../../src/lib/waf/crs-plugins/quarantine');
const rateLimit = await import('../../../src/lib/auth/rate-limit');
const { saveSettings } = await import('../../../src/lib/settings/resolve');
const { certificateExpiryAlertDays } = await import('../../../src/lib/settings/registry');
type Access = import('../../../src/lib/users/permissions').Access;

const NOW = new Date().toISOString();

function access(role: 'admin' | 'operator', hosts: number[] = []): Access {
  return {
    userId: 1,
    role,
    isAdmin: role === 'admin',
    isOperator: role === 'operator',
    grants: {
      proxyHosts: new Map(hosts.map((id) => [id, 'view' as const])),
      l4ProxyHosts: new Map(),
      agents: new Map(),
    },
  };
}

const only = (...ids: string[]) => ATTENTION_PROVIDER_LIST.filter((p) => ids.includes(p.id));

beforeEach(async () => {
  await saveSettings({ [certificateExpiryAlertDays.key]: 14 });
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.certificates);
  await ctx.db.delete(schema.users);
});

describe('caddy apply', () => {
  it('lists a refusal until a load succeeds, and ignores an unreachable Caddy', async () => {
    await recordApplyFailure(null, new CaddyApplyError('unreachable', 'CADDY_UNREACHABLE'));
    expect(await getApplyFailures()).toEqual({});

    await recordApplyFailure(
      { agentId: 'a1', name: 'edge-1' },
      new CaddyApplyError('bad handler', 'CADDY_REJECTED'),
    );
    let list = await collectAttention(access('admin'), { providers: only('caddyApply') });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      code: 'caddyApplyFailed',
      severity: 'critical',
      values: { scope: 'agent', agent: 'edge-1', error: 'bad handler' },
    });

    // Another agent's success leaves this one's refusal standing.
    await recordApplySuccess({ agentId: 'a2' });
    expect(Object.keys(await getApplyFailures())).toEqual(['a1']);
    await recordApplySuccess(null);
    list = await collectAttention(access('admin'), { providers: only('caddyApply') });
    expect(list.items).toEqual([]);
  });
});

describe('certificates', () => {
  it('names an imported certificate close to expiry, scoped to the hosts using it', async () => {
    const { certificatePem } = createSelfSignedServerCertificate('soon.example.com', [
      'soon.example.com',
    ]);
    const [cert] = await ctx.db
      .insert(schema.certificates)
      .values({
        name: 'Soon',
        type: 'imported',
        domainNames: JSON.stringify(['soon.example.com']),
        certificatePem,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    // Valid for 30 days: inside a 60-day threshold, outside the default 14.
    const [host] = await ctx.db
      .insert(schema.proxyHosts)
      .values({
        name: 'Soon host',
        domains: JSON.stringify(['soon.example.com']),
        upstreams: JSON.stringify(['http://app:80']),
        certificateId: cert!.id,
        createdAt: NOW,
        updatedAt: NOW,
      } as typeof schema.proxyHosts.$inferInsert)
      .returning();

    expect(
      (await collectAttention(access('admin'), { providers: only('certificates') })).items,
    ).toEqual([]);

    await saveSettings({ [certificateExpiryAlertDays.key]: 60 });
    const list = await collectAttention(access('admin'), { providers: only('certificates') });
    expect(list.items.map((i) => [i.code, i.scope.proxyHosts])).toEqual([
      ['certificateExpiring', [host!.id]],
    ]);

    // An operator granted the host sees it; one without the grant does not.
    expect(
      (await collectAttention(access('operator', [host!.id]), { providers: only('certificates') }))
        .items,
    ).toHaveLength(1);
    expect(
      (await collectAttention(access('operator', [999]), { providers: only('certificates') }))
        .items,
    ).toHaveLength(0);
  });
});

describe('CRS plugins', () => {
  it('lists a plugin the recovery switched off, with its name', async () => {
    const [plugin] = await ctx.db
      .insert(schema.crsPlugins)
      .values({
        name: 'wordpress-rule-exclusions',
        repository: 'example/wordpress-rule-exclusions',
        version: '1.2.0',
        ruleIdStart: 9507000,
        ruleIdEnd: 9507999,
        configRules: '',
        beforeRules: '',
        afterRules: '',
        createdAt: NOW,
        updatedAt: NOW,
      } as typeof schema.crsPlugins.$inferInsert)
      .returning();
    await setCrsPluginQuarantine({ [plugin!.id]: { at: NOW, version: '1.2.0' } });
    const list = await collectAttention(access('admin'), { providers: only('crsPlugins') });
    expect(list.items[0]).toMatchObject({
      code: 'crsPluginDisabled',
      values: { name: 'wordpress-rule-exclusions', version: '1.2.0' },
      href: '/waf',
    });
  });
});

describe('accounts', () => {
  it('lists a real account the lock holds, never a name nobody owns', async () => {
    await ctx.db.insert(schema.users).values({
      id: 5,
      email: 'sam@example.com',
      name: 'Sam',
      role: 'user',
      provider: 'credentials',
      subject: 'sam',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const policy = { ...rateLimit.DEFAULT_ACCOUNT_LOCK, freeFailures: 0 };
    const now = Date.now();
    await rateLimit.registerAccountFailure(rateLimit.accountKey('sam@example.com'), now, policy);
    await rateLimit.registerAccountFailure(rateLimit.accountKey('nobody'), now, policy);
    try {
      const list = await collectAttention(access('admin'), {
        providers: only('accounts'),
        now,
      });
      expect(list.items.map((i) => [i.code, i.values.email])).toEqual([
        ['accountLocked', 'sam@example.com'],
      ]);
    } finally {
      rateLimit.resetAccountFailures(rateLimit.accountKey('sam@example.com'));
      rateLimit.resetAccountFailures(rateLimit.accountKey('nobody'));
    }
  });
});

describe('security', () => {
  it('warns about access-list geo rules the running Caddy cannot enforce', async () => {
    const { saveCaddyBuildSettings } = await import('../../../src/lib/settings');
    const { CADDY_MODULES } = await import('../../../src/lib/caddy/image-build/modules');
    await ctx.db.delete(schema.accessListIpRules);
    await ctx.db.delete(schema.accessLists);
    const [list] = await ctx.db
      .insert(schema.accessLists)
      .values({ name: 'travel', createdAt: NOW, updatedAt: NOW })
      .returning();
    await ctx.db.insert(schema.accessListIpRules).values([
      {
        accessListId: list!.id,
        action: 'deny',
        country: 'RU',
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      // Expired, so it no longer counts.
      {
        accessListId: list!.id,
        action: 'deny',
        asn: 1,
        sortOrder: 1,
        expiresAt: '2000-01-01T00:00:00.000Z',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const items = async () =>
      (await collectAttention(access('admin'), { providers: only('security') })).items.filter(
        (item) => item.code === 'accessListGeoUnenforced',
      );
    expect(await items()).toEqual([]);

    await saveCaddyBuildSettings({
      modules: Object.fromEntries(CADDY_MODULES.map((m) => [m.id, m.id !== 'caddy-blocker'])),
      customModules: [],
    });
    expect(await items()).toMatchObject([
      { severity: 'warning', values: { count: 1 }, href: '/access-lists' },
    ]);
  });
});

describe('without agents, ClickHouse or directories', () => {
  it('answers nothing rather than reporting everything as broken', async () => {
    const list = await collectAttention(access('admin'), {
      providers: only('agents', 'traffic', 'ldap', 'l4Ports', 'geoip'),
    });
    expect(list.items).toEqual([]);
    expect(list.skipped).toEqual([]);
  });
});
