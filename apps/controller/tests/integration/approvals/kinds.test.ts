/**
 * Every kind of change a policy can hold, end to end: submitted under "everything", shown with a
 * preview, and applied by an approval through the same model call a direct write makes. A kind
 * whose model needs something a test has no way to give (Coraza on an agent, a plugin registry)
 * still runs its apply, and fails it with a recorded reason instead of applying half of it.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
import {
  type Change,
  approveChange,
  getChangeRequest,
  submitOrApply,
} from '../../../src/lib/approvals';
import { saveApprovalPolicy } from '../../../src/lib/approvals/kinds';
import { DEFAULT_APPROVAL_POLICY } from '../../../src/lib/approvals/policy';
import { ChangeSubmitted } from '../../../src/lib/approvals/submitted';
import { CHANGE_KINDS, type ChangeKind } from '../../../src/lib/approvals/types';
import { createProxyHost, deleteProxyHost } from '../../../src/lib/models/proxy-hosts';
import { createL4ProxyHost } from '../../../src/lib/models/l4-proxy-hosts';
import { addAccessListEntry, createAccessList } from '../../../src/lib/models/access-lists';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';
import { schema as gqlSchema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { accessOf } from '../../helpers/access';

let alice = 0;
let bob = 0;

type Fixtures = {
  host: number;
  other: number;
  l4: number;
  list: number;
  entry: number;
  preset: number;
  exclusion: number;
  plugin: number;
  rule: number;
  deletedRevision: number;
  revision: number;
};

async function fixtures(): Promise<Fixtures> {
  const now = new Date().toISOString();
  const host = await createProxyHost(
    { name: 'shop', domains: ['shop.example.com'], upstreams: ['app:8080'] },
    alice,
  );
  const other = await createProxyHost(
    { name: 'blog', domains: ['blog.example.com'], upstreams: ['app:8080'] },
    alice,
  );
  const gone = await createProxyHost(
    { name: 'old', domains: ['old.example.com'], upstreams: ['app:8080'] },
    alice,
  );
  await deleteProxyHost(gone.id, alice);
  const l4 = await createL4ProxyHost(
    { name: 'db', protocol: 'tcp', listenAddress: ':15432', upstreams: ['db:5432'] },
    alice,
  );
  const list = await createAccessList({ name: 'Staff' }, alice);
  const withEntry = await addAccessListEntry(
    list.id,
    { username: 'sam', password: 'correct horse battery' },
    alice,
  );
  const [preset] = await ctx.db
    .insert(schema.wafPresets)
    .values({ name: 'Strict', directives: 'SecRuleEngine On', createdAt: now, updatedAt: now })
    .returning();
  const [exclusion] = await ctx.db
    .insert(schema.wafExclusions)
    .values({ ruleId: 942100, reason: 'search box', createdAt: now, updatedAt: now })
    .returning();
  const [plugin] = await ctx.db
    .insert(schema.crsPlugins)
    .values({
      name: 'wordpress-rule-exclusions',
      repository: 'coreruleset/wordpress-rule-exclusions-plugin',
      version: '1.0.0',
      ruleIdStart: 9507000,
      ruleIdEnd: 9507999,
      configRules: '',
      beforeRules: '',
      afterRules: '',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const [rule] = await ctx.db
    .insert(schema.mtlsAccessRules)
    .values({ proxyHostId: host.id, pathPattern: '/admin', createdAt: now, updatedAt: now })
    .returning();
  const revisions = await ctx.db.select().from(schema.hostRevisions);
  const deletedRevision = revisions.filter((row) => row.hostId === gone.id).at(-1)!.id;
  const revision = revisions.find((row) => row.hostId === host.id)!.id;
  return {
    host: host.id,
    other: other.id,
    l4: l4.id,
    list: list.id,
    entry: withEntry.entries[0].id,
    preset: preset.id,
    exclusion: exclusion.id,
    plugin: plugin.id,
    rule: rule.id,
    deletedRevision,
    revision,
  };
}

/** One change of each kind, against the fixtures. */
function changeOf(kind: ChangeKind, f: Fixtures): Change {
  const changes: { [K in ChangeKind]: Change<K>['payload'] } = {
    proxyHostCreate: {
      input: { name: 'new', domains: ['new.example.com'], upstreams: ['app:8080'] },
      forwardAuthAccess: { userIds: [], groupIds: [] },
    },
    proxyHostUpdate: { id: f.host, input: { name: 'store' } },
    proxyHostDelete: { id: f.other },
    proxyHostMaintenance: { id: f.host, enabled: true },
    proxyHostBulk: { action: 'addTag', ids: [f.host, f.other], tag: 'shop' },
    forwardAuthAccess: { hostId: f.host, access: { userIds: [alice], groupIds: [] } },
    mtlsRuleCreate: { input: { proxyHostId: f.host, pathPattern: '/billing' } },
    mtlsRuleUpdate: { id: f.rule, input: { pathPattern: '/staff' } },
    mtlsRuleDelete: { id: f.rule },
    l4HostCreate: {
      input: { name: 'cache', protocol: 'tcp', listenAddress: ':16379', upstreams: ['redis:6379'] },
    },
    l4HostUpdate: { id: f.l4, input: { name: 'database' } },
    l4HostDelete: { id: f.l4 },
    l4HostBulk: { action: 'disable', ids: [f.l4] },
    hostRollback: { revisionId: f.revision },
    hostRestore: { revisionId: f.deletedRevision, dropMissingReferences: false },
    accessListCreate: {
      input: { name: 'Contractors', users: [{ username: 'kim', password: 'p' }] },
    },
    accessListUpdate: { id: f.list, input: { name: 'Employees' } },
    accessListDelete: { id: f.list },
    accessListRules: { id: f.list, rules: [{ action: 'deny', cidr: '192.0.2.0/24' }] },
    accessListEntryAdd: { id: f.list, entry: { username: 'lee', password: 'another one' } },
    accessListEntryRemove: { id: f.list, entryIds: [f.entry] },
    wafPresetCreate: { input: { name: 'Loose', directives: 'SecRuleEngine DetectionOnly' } },
    wafPresetUpdate: { id: f.preset, input: { description: 'for the shop' } },
    wafPresetDelete: { id: f.preset },
    wafExclusionCreate: { input: { ruleId: 941100, reason: 'rich text' } },
    wafExclusionUpdate: { id: f.exclusion, input: { ruleId: 942100, reason: 'search' } },
    wafExclusionDelete: { id: f.exclusion },
    crsPluginInstall: { registryId: 'none', name: 'not-a-plugin' },
    crsPluginUpdate: { id: f.plugin },
    crsPluginConfig: { id: f.plugin, config: 'SecAction "id:9507010,phase:1,pass,nolog"' },
    crsPluginUninstall: { id: f.plugin },
    settingsApply: { entries: [{ key: 'config:app_name', value: JSON.stringify('Edge') }] },
    settingsGroup: { group: 'compression', input: { enabled: false } },
    approvalPolicy: {
      policy: { ...DEFAULT_APPROVAL_POLICY, enabled: true, approverRoles: ['admin'] },
    },
  };
  return { kind, payload: changes[kind] } as Change;
}

/** Need something outside the test: Coraza on an agent, or a plugin registry. */
const MAY_FAIL: readonly ChangeKind[] = [
  'wafPresetCreate',
  'wafPresetUpdate',
  'wafExclusionCreate',
  'wafExclusionUpdate',
  'crsPluginInstall',
  'crsPluginUpdate',
  'crsPluginConfig',
];

beforeEach(async () => {
  for (const table of [
    schema.changeRequests,
    schema.mtlsAccessRules,
    schema.wafExclusions,
    schema.wafPresets,
    schema.crsPlugins,
    schema.hostRevisions,
    schema.proxyHosts,
    schema.l4ProxyHosts,
    schema.accessLists,
    schema.settingsRevisions,
    schema.settings,
    schema.users,
  ]) {
    await ctx.db.delete(table);
  }
  invalidateSettingsCache();
  const now = new Date().toISOString();
  const people = await ctx.db
    .insert(schema.users)
    .values([
      { email: 'alice@example.com', name: 'Alice', role: 'admin', createdAt: now, updatedAt: now },
      { email: 'bob@example.com', name: 'Bob', role: 'admin', createdAt: now, updatedAt: now },
    ])
    .returning();
  [alice, bob] = people.map((person) => person.id);
});

describe('every kind of change', () => {
  it.each(CHANGE_KINDS.map((kind) => [kind]))(
    '%s waits, then applies when approved',
    async (kind) => {
      const f = await fixtures();
      await saveApprovalPolicy(
        { ...DEFAULT_APPROVAL_POLICY, enabled: true, approverRoles: ['admin'] },
        alice,
      );
      let id = 0;
      try {
        await submitOrApply({ userId: alice }, changeOf(kind, f));
      } catch (error) {
        if (!(error instanceof ChangeSubmitted)) throw error;
        id = error.requestId;
      }
      expect(id).toBeGreaterThan(0);
      const pending = await getChangeRequest(id, { access: accessOf('admin', {}, bob) });
      expect(pending).toMatchObject({ kind, status: 'pending' });
      expect(['host', 'fields', 'settings']).toContain(pending?.preview.type ?? '');

      const { status } = await approveChange(id, accessOf('admin', {}, bob));
      const after = await getChangeRequest(id, { access: accessOf('admin', {}, bob) });
      if (MAY_FAIL.includes(kind)) {
        expect(['applied', 'failed']).toContain(status);
        if (status === 'failed') expect(after?.error).toBeTruthy();
      } else {
        expect({ kind, status, error: after?.error ?? null }).toEqual({
          kind,
          status: 'applied',
          error: null,
        });
      }
    },
  );
});

describe('the approvals API', () => {
  it('lists, reads, decides and sets the policy over GraphQL', async () => {
    const f = await fixtures();
    const context = (userId: number, method: 'session' | 'bearer' = 'session'): GraphQLContext => ({
      viewer: async () => ({ userId, role: 'admin', authMethod: method }),
      access: async () => accessOf('admin', {}, userId),
      rawBody: async () => '',
      request: {} as never,
    });
    const run = (source: string, userId: number, variables: Record<string, unknown> = {}) =>
      graphql({
        schema: gqlSchema,
        source,
        variableValues: variables,
        contextValue: context(userId),
      });

    const set = await run(
      'mutation ($input: JSON!) { setApprovalPolicy(input: $input) { enabled requiredApprovals approverRoles } }',
      alice,
      { input: { enabled: true, approverRoles: ['admin'], requiredApprovals: 1 } },
    );
    expect(set.errors).toBeUndefined();
    expect(set.data?.setApprovalPolicy).toEqual({
      enabled: true,
      requiredApprovals: 1,
      approverRoles: ['admin'],
    });
    const read = await run('{ approvalPolicy { enabled scope applyToTokens } }', bob);
    expect(read.data?.approvalPolicy).toEqual({
      enabled: true,
      scope: 'everything',
      applyToTokens: true,
    });

    const ids: number[] = [];
    for (const name of ['one', 'two', 'three', 'four']) {
      const answer = await run(
        'mutation ($id: Int!, $input: JSON!) { updateProxyHost(id: $id, input: $input) { id } }',
        alice,
        { id: f.host, input: { name } },
      );
      expect(answer.errors?.[0]?.extensions?.code).toBe('PENDING_APPROVAL');
      ids.push(answer.errors?.[0]?.extensions?.changeRequestId as number);
    }

    const listed = await run('{ changeRequests(status: "pending") { id kind status } }', bob);
    expect((listed.data!.changeRequests as { id: number }[]).map((row) => row.id).sort()).toEqual(
      [...ids].sort(),
    );
    const one = await run(
      'query ($id: Int!) { changeRequest(id: $id) { id targetName mayDecide preview } }',
      bob,
      { id: ids[0] },
    );
    expect(one.errors).toBeUndefined();
    expect(one.data?.changeRequest).toMatchObject({
      id: ids[0],
      targetName: 'shop',
      mayDecide: true,
    });

    const rejected = await run(
      'mutation ($id: Int!) { rejectChangeRequest(id: $id, note: "no") { status decisions { decision note } } }',
      bob,
      { id: ids[0] },
    );
    expect(rejected.data?.rejectChangeRequest).toEqual({
      status: 'rejected',
      decisions: [{ decision: 'reject', note: 'no' }],
    });
    const withdrawn = await run(
      'mutation ($id: Int!) { withdrawChangeRequest(id: $id) { status } }',
      alice,
      { id: ids[1] },
    );
    expect(withdrawn.data?.withdrawChangeRequest).toEqual({ status: 'withdrawn' });
    const bypassed = await run(
      'mutation ($id: Int!) { bypassChangeRequest(id: $id, reason: "urgent") { status bypassReason } }',
      bob,
      { id: ids[2] },
    );
    expect(bypassed.data?.bypassChangeRequest).toEqual({
      status: 'applied',
      bypassReason: 'urgent',
    });
    // Submitted before the bypass changed the host, so it is out of date now.
    const approved = await run(
      'mutation ($id: Int!) { approveChangeRequest(id: $id) { status approvals } }',
      bob,
      { id: ids[3] },
    );
    expect(approved.errors?.[0]?.message).toContain('has changed since it was submitted');

    const missing = await run('{ changeRequest(id: 999999) { id } }', bob);
    expect(missing.data?.changeRequest).toBeNull();
  });

  it('answers a host it cannot find with the model refusal', async () => {
    await saveApprovalPolicy(
      { ...DEFAULT_APPROVAL_POLICY, enabled: true, approverRoles: ['admin'] },
      alice,
    );
    let code = '';
    try {
      await submitOrApply({ userId: alice }, { kind: 'proxyHostDelete', payload: { id: 424242 } });
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('proxyHostNotFound');
    const rows = await ctx.db.select().from(schema.changeRequests);
    expect(rows).toEqual([]);
    const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, alice));
    expect(user.email).toBe('alice@example.com');
  });
});
