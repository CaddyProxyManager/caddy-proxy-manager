/**
 * Change approvals on the database: a covered write becomes a request instead of a change, an
 * approver other than its requester applies it as the requester, a second approval is waited for
 * when the policy asks for two, a target that moved invalidates it, two approvals racing apply it
 * once, an administrator's bypass is audited and alerted, and API tokens wait (202) or skip it as
 * "Apply to API tokens" says.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { auditEvents } from '@/tests/helpers/audit-events';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
import { logAuditEvent } from '../../../src/lib/audit';
import { DomainError } from '../../../src/lib/errors/domain-error';
import {
  apiSubmitter,
  approveChange,
  bypassChange,
  getChangeRequest,
  listChangeRequests,
  needsApproval,
  recoverStalledApplies,
  STALE_APPLY_MS,
  rejectChange,
  submitIfCovered,
  submitOrApply,
  withdrawChange,
} from '../../../src/lib/approvals';
import { saveApprovalPolicy } from '../../../src/lib/approvals/kinds';
import { DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from '../../../src/lib/approvals/policy';
import { ChangeSubmitted } from '../../../src/lib/approvals/submitted';
import {
  createProxyHost,
  getProxyHost,
  updateProxyHost,
} from '../../../src/lib/models/proxy-hosts';
import { getAccessList } from '../../../src/lib/models/access-lists';
import { createApiToken } from '../../../src/lib/models/api-tokens';
import { createRule } from '../../../src/lib/alerts/rule-store';
import { flushNotifications, resetNotificationsForTests } from '../../../src/lib/notifications';
import { BATCH_MS } from '../../../src/lib/notifications/plan';
import { encryptSecret, isEncryptedSecret } from '../../../src/lib/secrets';
import { stageWrites } from '../../../src/lib/settings/staging';
import { invalidateSettingsCache } from '../../../src/lib/settings/resolve';
import { schema as gqlSchema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import { accessOf } from '../../helpers/access';

const logged = auditEvents(() => ctx.db);
const ids = { alice: 0, bob: 0, carol: 0, dave: 0 };
let server: ReturnType<typeof Bun.serve>;
let posts: string[] = [];

const as = (who: keyof typeof ids, role = 'admin') => accessOf(role, {}, ids[who]);

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The request id a covered write was turned into. */
async function submitted(work: Promise<unknown>): Promise<number> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ChangeSubmitted) return error.requestId;
    throw error;
  }
  throw new Error('expected the write to wait for approval');
}

async function policy(overrides: Partial<ApprovalPolicy> = {}) {
  await saveApprovalPolicy(
    { ...DEFAULT_APPROVAL_POLICY, enabled: true, approverRoles: ['admin'], ...overrides },
    ids.alice,
  );
}

const host = (name: string, tags: string[] = []) =>
  createProxyHost(
    { name, domains: [`${name}.example.com`], upstreams: ['app:8080'], tags },
    ids.alice,
  );

const rename = (id: number, name: string, by = ids.alice) =>
  submitOrApply({ userId: by }, { kind: 'proxyHostUpdate', payload: { id, input: { name } } });

const revisionsOf = (hostId: number) =>
  ctx.db
    .select()
    .from(schema.hostRevisions)
    .where(eq(schema.hostRevisions.hostId, hostId))
    .orderBy(asc(schema.hostRevisions.id));

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      posts.push(JSON.parse(await request.text()).text as string);
      return new Response('ok');
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  posts = [];
  await resetNotificationsForTests();
  for (const table of [
    schema.changeRequests,
    schema.hostRevisions,
    schema.proxyHosts,
    schema.accessLists,
    schema.apiTokens,
    schema.settingsStaged,
    schema.settingsRevisions,
    schema.settings,
    schema.auditEvents,
    schema.users,
  ]) {
    await ctx.db.delete(table);
  }
  invalidateSettingsCache();
  logged.reset();
  vi.mocked(logAuditEvent).mockClear();
  const now = new Date().toISOString();
  const people = await ctx.db
    .insert(schema.users)
    .values([
      { email: 'alice@example.com', name: 'Alice', role: 'admin', createdAt: now, updatedAt: now },
      { email: 'bob@example.com', name: 'Bob', role: 'admin', createdAt: now, updatedAt: now },
      { email: 'carol@example.com', name: 'Carol', role: 'admin', createdAt: now, updatedAt: now },
      { email: 'dave@example.com', name: 'Dave', role: 'viewer', createdAt: now, updatedAt: now },
    ])
    .returning();
  [ids.alice, ids.bob, ids.carol, ids.dave] = people.map((person) => person.id);
});

describe('the lifecycle', () => {
  it('applies a write at once while the policy is off', async () => {
    const made = await host('shop');
    const renamed = await rename(made.id, 'store');
    expect(renamed.name).toBe('store');
    expect(await ctx.db.select().from(schema.changeRequests)).toEqual([]);
  });

  it('holds a covered write, and applies it as the requester once someone else approves', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    expect((await getProxyHost(made.id))?.name).toBe('shop');

    const request = await getChangeRequest(id, { access: as('bob') });
    expect(request).toMatchObject({
      kind: 'proxyHostUpdate',
      area: 'hosts',
      status: 'pending',
      targetName: 'shop',
      requestedBy: ids.alice,
      requestedByName: 'Alice',
      requiredApprovals: 1,
      mayDecide: true,
      mayWithdraw: false,
      mayBypass: true,
    });
    // Approvers read the editor's own review: the field diff and what it sets off.
    expect(request?.preview.type).toBe('host');
    if (request?.preview.type === 'host') {
      expect(request.preview.host.changes.map((change) => change.field)).toEqual(['name']);
    }

    expect(await codeOf(approveChange(id, as('alice')))).toBe('changeRequestSelfApproval');
    expect(await codeOf(approveChange(id, as('dave', 'viewer')))).toBe('changeRequestNotApprover');

    expect(await approveChange(id, as('bob'), 'looks right')).toMatchObject({
      status: 'applied',
      approvals: 1,
    });
    expect((await getProxyHost(made.id))?.name).toBe('store');

    // Recorded as the requester's write, with the request and its approver beside it.
    const revisions = await revisionsOf(made.id);
    const last = revisions.at(-1)!;
    expect(last.userId).toBe(ids.alice);
    expect(JSON.parse(last.detail ?? '{}')).toEqual({ changeRequest: id });
    const audit = (await logged.list()).find(
      (event) => event.entityType === 'proxy_host' && event.action === 'update',
    );
    expect(audit?.userId).toBe(ids.alice);
    expect(audit?.data?.approval).toEqual({
      changeRequest: id,
      approvedBy: [{ id: ids.bob, name: 'Bob' }],
    });
    const after = await getChangeRequest(id, { access: as('alice') });
    expect(after).toMatchObject({ status: 'applied', approvals: 1, mayWithdraw: false });
    expect(after?.decisions).toMatchObject([
      { userId: ids.bob, decision: 'approve', note: 'looks right' },
    ]);
  });

  it('waits for a second approval when the policy asks for two', async () => {
    const made = await host('shop');
    await policy({ requiredApprovals: 2 });
    const id = await submitted(rename(made.id, 'store'));
    expect(await approveChange(id, as('bob'))).toMatchObject({ status: 'pending', approvals: 1 });
    expect((await getProxyHost(made.id))?.name).toBe('shop');
    expect(await codeOf(approveChange(id, as('bob')))).toBe('changeRequestAlreadyDecided');
    expect(await approveChange(id, as('carol'))).toMatchObject({
      status: 'applied',
      approvals: 2,
    });
    expect((await getProxyHost(made.id))?.name).toBe('store');
  });

  it('ends at a rejection, and lets only the requester withdraw', async () => {
    const made = await host('shop');
    await policy();
    const rejected = await submitted(rename(made.id, 'store'));
    await rejectChange(rejected, as('bob'), 'not today');
    expect((await getChangeRequest(rejected, { access: as('bob') }))?.status).toBe('rejected');
    expect(await codeOf(approveChange(rejected, as('carol')))).toBe('changeRequestNotPending');

    const withdrawn = await submitted(rename(made.id, 'store'));
    expect(await codeOf(withdrawChange(withdrawn, as('bob')))).toBe('changeRequestNotYours');
    await withdrawChange(withdrawn, as('alice'));
    expect((await getChangeRequest(withdrawn, { access: as('alice') }))?.status).toBe('withdrawn');
    expect((await getProxyHost(made.id))?.name).toBe('shop');
  });

  it('shows an account outside the approvers only its own requests', async () => {
    const made = await host('shop');
    await policy();
    await submitted(rename(made.id, 'store'));
    await ctx.db.update(schema.users).set({ role: 'user' }).where(eq(schema.users.id, ids.dave));
    expect(await listChangeRequests({ access: as('dave', 'user') })).toEqual([]);
    expect(await listChangeRequests({ access: as('bob') })).toHaveLength(1);
  });

  it('keeps what the change would write sealed at rest', async () => {
    const made = await host('shop');
    await policy();
    await submitted(rename(made.id, 'store'));
    const [row] = await ctx.db.select().from(schema.changeRequests);
    expect(isEncryptedSecret(row.payload)).toBe(true);
    expect(row.payload).not.toContain('store');
  });
});

describe('a target that changed', () => {
  it('invalidates the request instead of applying it over the newer state', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    // Someone changes the host by another way: the policy covers nothing for a moment.
    await saveApprovalPolicy({ ...DEFAULT_APPROVAL_POLICY }, ids.alice);
    await updateProxyHost(made.id, { name: 'boutique' }, ids.carol);
    await policy();

    expect(await codeOf(approveChange(id, as('bob')))).toBe('changeRequestTargetChanged');
    expect((await getChangeRequest(id, { access: as('bob') }))?.status).toBe('invalidated');
    expect((await getProxyHost(made.id))?.name).toBe('boutique');
  });

  it('is swept out of the pending list', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    await ctx.db
      .update(schema.proxyHosts)
      .set({ description: 'edited elsewhere' })
      .where(eq(schema.proxyHosts.id, made.id));
    const [listed] = await listChangeRequests({ access: as('bob') }, { status: 'decided' });
    expect(listed).toMatchObject({ id, status: 'invalidated' });
  });
});

describe('two approvals racing', () => {
  it('apply the change once', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    const before = (await revisionsOf(made.id)).length;
    await Promise.allSettled([approveChange(id, as('bob')), approveChange(id, as('carol'))]);
    expect((await revisionsOf(made.id)).length).toBe(before + 1);
    expect((await getChangeRequest(id, { access: as('bob') }))?.status).toBe('applied');
  });

  it('apply it once when both are needed and arrive together', async () => {
    const made = await host('shop');
    await policy({ requiredApprovals: 2 });
    const id = await submitted(rename(made.id, 'store'));
    const before = (await revisionsOf(made.id)).length;
    await Promise.allSettled([approveChange(id, as('bob')), approveChange(id, as('carol'))]);
    expect((await revisionsOf(made.id)).length).toBe(before + 1);
    expect((await getChangeRequest(id, { access: as('bob') }))?.status).toBe('applied');
  });
});

describe('an apply a crashed process left behind', () => {
  const longAgo = () => new Date(Date.now() - STALE_APPLY_MS - 60_000).toISOString();

  /** Leaves the request as a process that died after claiming it would. */
  const strand = (id: number, decidedAt = longAgo()) =>
    ctx.db
      .update(schema.changeRequests)
      .set({ status: 'applying', decidedAt, appliedAt: null })
      .where(eq(schema.changeRequests.id, id));

  const statusOf = async (id: number) =>
    (await ctx.db.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, id)))[0];

  it('fails one that died before the write, without applying it', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    await strand(id);
    const before = (await revisionsOf(made.id)).length;

    const [listed] = await listChangeRequests({ access: as('bob') }, { status: 'decided' });
    expect(listed).toMatchObject({ id, status: 'failed', resultCode: 'changeRequestInterrupted' });
    expect((await getProxyHost(made.id))?.name).toBe('shop');
    expect((await revisionsOf(made.id)).length).toBe(before);
  });

  it('marks one that died after the write applied, without applying it again', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    await approveChange(id, as('bob'));
    await strand(id);
    const before = (await revisionsOf(made.id)).length;

    expect((await getChangeRequest(id, { access: as('bob') }))?.status).toBe('applied');
    expect((await statusOf(id)).appliedAt).not.toBeNull();
    expect((await revisionsOf(made.id)).length).toBe(before);
  });

  it('reads the stamped audit event when there is no host revision', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    await approveChange(id, as('bob'));
    await strand(id);
    await ctx.db.delete(schema.hostRevisions);
    expect(await recoverStalledApplies()).toBe(1);
    expect((await statusOf(id)).status).toBe('applied');
  });

  it('cannot tell once the target moved, and says so rather than guessing', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    await strand(id);
    await ctx.db
      .update(schema.proxyHosts)
      .set({ description: 'edited elsewhere' })
      .where(eq(schema.proxyHosts.id, made.id));
    await recoverStalledApplies();
    expect(await statusOf(id)).toMatchObject({
      status: 'failed',
      resultCode: 'changeRequestInterruptedUnknown',
    });
  });

  it('leaves an apply still within its time alone', async () => {
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));
    await strand(id, new Date().toISOString());
    expect(await recoverStalledApplies()).toBe(0);
    expect((await statusOf(id)).status).toBe('applying');
  });

  it('settles it once when two replicas take over at the same moment', async () => {
    const made = await host('shop');
    await policy();
    const applied = await submitted(rename(made.id, 'store'));
    await approveChange(applied, as('bob'));
    await strand(applied);
    const other = await host('cafe');
    const interrupted = await submitted(rename(other.id, 'bistro'));
    await strand(interrupted);
    vi.mocked(logAuditEvent).mockClear();

    const settled = await Promise.all([recoverStalledApplies(), recoverStalledApplies()]);
    expect(settled[0] + settled[1]).toBe(2);
    expect((await statusOf(applied)).status).toBe('applied');
    expect((await statusOf(interrupted)).status).toBe('failed');
    const recovered = vi
      .mocked(logAuditEvent)
      .mock.calls.map(([event]) => event)
      .filter((event) => event.entityType === 'change_request');
    expect(recovered.map((event) => [event.action, event.entityId]).sort()).toEqual(
      [
        ['change_request_applied', applied],
        ['change_request_failed', interrupted],
      ].sort(),
    );
  });
});

describe('an emergency bypass', () => {
  it('applies at once for an administrator, audited and raised as an alert', async () => {
    const now = new Date().toISOString();
    const [channel] = await ctx.db
      .insert(schema.notificationChannels)
      .values({
        name: 'chat',
        kind: 'slack',
        secret: encryptSecret(JSON.stringify({ url: `http://127.0.0.1:${server.port}/slack` })),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await createRule(
      {
        name: 'bypasses',
        source: 'event',
        kinds: ['changeApprovalBypassed'],
        channelIds: [channel.id],
      },
      ids.alice,
    );
    const made = await host('shop');
    await policy();
    const id = await submitted(rename(made.id, 'store'));

    expect(await codeOf(bypassChange(id, as('dave', 'viewer'), 'outage'))).toBe(
      'changeRequestBypassAdmin',
    );
    expect(await codeOf(bypassChange(id, as('bob'), '  '))).toBe('changeRequestBypassReason');
    expect(await bypassChange(id, as('bob'), 'outage on the payment page')).toBe('applied');
    expect((await getProxyHost(made.id))?.name).toBe('store');

    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'change_request_bypassed',
        entityId: id,
        userId: ids.bob,
        data: { reason: 'outage on the payment page' },
      }),
    );
    const audit = (await logged.list()).find(
      (event) => event.entityType === 'proxy_host' && event.action === 'update',
    );
    expect(audit?.data?.approval).toMatchObject({
      changeRequest: id,
      approvedBy: [],
      bypass: { by: ids.bob, reason: 'outage on the payment page' },
    });
    expect((await getChangeRequest(id, { access: as('bob') }))?.bypassReason).toBe(
      'outage on the payment page',
    );

    await flushNotifications(Date.now() + BATCH_MS);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`#${id}`);
    expect(posts[0]).toContain('outage on the payment page');
  });
});

describe('API tokens', () => {
  async function token() {
    const { rawToken } = await createApiToken('automation', ids.alice);
    return rawToken;
  }

  it('wait over REST: 202 with the request id, attributed to the token owner', async () => {
    const made = await host('shop');
    await policy();
    const raw = await token();
    const { PUT } = await import('../../../src/app/api/v1/proxy-hosts/[id]/route');
    const { NextRequest } = await import('next/server');
    const response = await PUT(
      new NextRequest(`http://localhost:3000/api/v1/proxy-hosts/${made.id}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'store' }),
      }),
      { params: Promise.resolve({ id: String(made.id) }) },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { changeRequestId: number; status: string };
    expect(body.status).toBe('pending');
    const request = await getChangeRequest(body.changeRequestId, { access: as('bob') });
    expect(request).toMatchObject({ requestedBy: ids.alice, viaToken: true, status: 'pending' });
    expect((await getProxyHost(made.id))?.name).toBe('shop');
  });

  it('wait over GraphQL: 202 with the request id in the error', async () => {
    const made = await host('shop');
    await policy();
    const raw = await token();
    const { POST } = await import('../../../src/app/api/graphql/route');
    const response = await POST(
      new Request('http://localhost:3000/api/graphql', {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            'mutation ($id: Int!) { updateProxyHost(id: $id, input: { name: "store" }) { id } }',
          variables: { id: made.id },
        }),
      }) as never,
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      errors: { extensions: { code: string; changeRequestId: number } }[];
    };
    expect(body.errors[0].extensions.code).toBe('PENDING_APPROVAL');
    const request = await getChangeRequest(body.errors[0].extensions.changeRequestId, {
      access: as('bob'),
    });
    expect(request).toMatchObject({ requestedBy: ids.alice, viaToken: true });
  });

  it('apply at once when the policy leaves tokens out, audited as having skipped approval', async () => {
    const made = await host('shop');
    await policy({ applyToTokens: false });
    await logged.clear();
    const renamed = await submitOrApply(apiSubmitter({ userId: ids.alice, authMethod: 'bearer' }), {
      kind: 'proxyHostUpdate',
      payload: { id: made.id, input: { name: 'store' } },
    });
    expect(renamed.name).toBe('store');
    const [audit] = await logged.list();
    expect(audit).toMatchObject({ entityType: 'proxy_host', action: 'update' });
    expect(audit.data?.approval).toEqual({ skipped: 'apiToken' });
    // A session through the same API still waits.
    await submitted(
      submitOrApply(apiSubmitter({ userId: ids.alice, authMethod: 'session' }), {
        kind: 'proxyHostUpdate',
        payload: { id: made.id, input: { name: 'boutique' } },
      }),
    );
  });
});

describe('what the policy covers', () => {
  it('names areas, or host tags before or after the change', async () => {
    const tagged = await host('pay', ['payments']);
    const plain = await host('blog');
    const by = { userId: ids.alice };
    await policy({ scope: 'tags', tags: ['payments'] });
    expect(
      await needsApproval(by, {
        kind: 'proxyHostUpdate',
        payload: { id: tagged.id, input: { name: 'x' } },
      }),
    ).toBe(true);
    expect(
      await needsApproval(by, {
        kind: 'proxyHostUpdate',
        payload: { id: plain.id, input: { name: 'x' } },
      }),
    ).toBe(false);
    // Tagging a host into the policy is itself held.
    expect(
      await needsApproval(by, {
        kind: 'proxyHostUpdate',
        payload: { id: plain.id, input: { tags: ['payments'] } },
      }),
    ).toBe(true);
    expect(
      await needsApproval(by, { kind: 'accessListCreate', payload: { input: { name: 'x' } } }),
    ).toBe(false);

    await policy({ scope: 'areas', areas: ['accessLists'] });
    expect(
      await needsApproval(by, { kind: 'accessListCreate', payload: { input: { name: 'x' } } }),
    ).toBe(true);
    expect(
      await needsApproval(by, {
        kind: 'proxyHostUpdate',
        payload: { id: plain.id, input: { name: 'x' } },
      }),
    ).toBe(false);
  });

  it('holds access list and settings changes, and applies them when approved', async () => {
    await policy({ scope: 'areas', areas: ['accessLists', 'settings'] });
    const listId = await submitted(
      submitOrApply(
        { userId: ids.alice },
        { kind: 'accessListCreate', payload: { input: { name: 'Staff' } } },
      ),
    );
    await approveChange(listId, as('bob'));
    const [list] = await ctx.db.select().from(schema.accessLists);
    expect(list.name).toBe('Staff');

    const rulesId = await submitted(
      submitOrApply(
        { userId: ids.alice },
        {
          kind: 'accessListRules',
          payload: { id: list.id, rules: [{ action: 'allow', cidr: '10.0.0.0/8' }] },
        },
      ),
    );
    await approveChange(rulesId, as('bob'));
    expect((await getAccessList(list.id))?.ipRules.map((rule) => rule.cidr)).toEqual([
      '10.0.0.0/8',
    ]);

    await stageWrites(ids.alice, new Map([['config:app_name', JSON.stringify('Edge')]]));
    const settingsId = await submitIfCovered(
      { userId: ids.alice },
      {
        kind: 'settingsApply',
        payload: { entries: [{ key: 'config:app_name', value: JSON.stringify('Edge') }] },
      },
    );
    expect(settingsId).not.toBeNull();
    const pending = await getChangeRequest(settingsId!, { access: as('bob') });
    expect(pending?.preview).toMatchObject({ type: 'settings', keys: ['config:app_name'] });
    await approveChange(settingsId!, as('bob'));
    const [stored] = await ctx.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, 'config:app_name'));
    expect(JSON.parse(stored.value)).toBe('Edge');
    const [revision] = await ctx.db.select().from(schema.settingsRevisions);
    expect(revision.appliedBy).toBe(ids.alice);
  });

  it('holds a change to the policy itself while settings are covered', async () => {
    await policy({ scope: 'areas', areas: ['settings'] });
    const id = await submitted(
      submitOrApply(
        { userId: ids.alice },
        { kind: 'approvalPolicy', payload: { policy: { ...DEFAULT_APPROVAL_POLICY } } },
      ),
    );
    await approveChange(id, as('bob'));
    expect(
      await needsApproval(
        { userId: ids.alice },
        { kind: 'accessListCreate', payload: { input: { name: 'x' } } },
      ),
    ).toBe(false);
  });

  it('refuses an invalid change at submission rather than queueing it', async () => {
    const made = await host('shop');
    await policy();
    expect(
      await codeOf(
        submitOrApply(
          { userId: ids.alice },
          { kind: 'proxyHostUpdate', payload: { id: made.id, input: { domains: [] } } },
        ),
      ),
    ).not.toBe('changeSubmittedForApproval');
    expect(await ctx.db.select().from(schema.changeRequests)).toEqual([]);
  });
});

describe('host history', () => {
  it('holds a rollback over GraphQL until approved', async () => {
    const made = await host('shop');
    await updateProxyHost(made.id, { name: 'store' }, ids.alice);
    const [first] = await revisionsOf(made.id);
    await policy();
    const context: GraphQLContext = {
      viewer: async () => ({ userId: ids.alice, role: 'admin', authMethod: 'session' as const }),
      access: async () => as('alice'),
      rawBody: async () => '',
      request: {} as never,
    };
    const answer = await graphql({
      schema: gqlSchema,
      source: 'mutation ($id: Int!) { rollbackHost(revisionId: $id) { id } }',
      variableValues: { id: first.id },
      contextValue: context,
    });
    const id = answer.errors?.[0]?.extensions?.changeRequestId as number;
    expect(answer.errors?.[0]?.extensions?.code).toBe('PENDING_APPROVAL');
    expect((await getProxyHost(made.id))?.name).toBe('store');
    await approveChange(id, as('bob'));
    expect((await getProxyHost(made.id))?.name).toBe('shop');
    const last = (await revisionsOf(made.id)).at(-1)!;
    expect(last.operation).toBe('rollback');
    expect(JSON.parse(last.detail ?? '{}')).toEqual({ revision: first.id, changeRequest: id });
  });
});
