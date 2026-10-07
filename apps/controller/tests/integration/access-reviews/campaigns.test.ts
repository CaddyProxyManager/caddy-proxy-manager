/**
 * Access reviews on the database: a campaign snapshots its scope with hints, each reviewer sees and
 * decides only their own items, every decision is audited, and closing applies the revocations as
 * the closer through the same guards the Users and Groups pages use, or holds them for an
 * administrator's confirmation.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { logAuditEvent } from '../../../src/lib/audit';
import * as schema from '../../../src/lib/db/schema';
import { DomainError } from '../../../src/lib/errors/domain-error';
import type { CapabilitySet } from '../../../src/lib/roles/capabilities';
import { invalidateSettingsCache, saveSettings } from '../../../src/lib/settings/resolve';
import { resetNotificationsForTests } from '../../../src/lib/notifications';
import {
  type ReviewActor,
  createCampaign,
  decideItem,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  pendingReviewsFor,
  reassignItems,
  updateCampaign,
} from '../../../src/lib/access-reviews';
import { closeCampaign, confirmCampaign } from '../../../src/lib/access-reviews/apply';
import { campaignCsvRows } from '../../../src/lib/access-reviews/csv';
import { accessOf, capabilitiesOf } from '../../helpers/access';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const ids = { admin: 0, alice: 0, bob: 0, carol: 0, dave: 0, eve: 0 };
const group = { ops: 0, scim: 0 };
const token = { alice: 0, admin: 0, expired: 0 };
let hostId = 0;

const ADMIN = (): ReviewActor => ({ userId: ids.admin, capabilities: capabilitiesOf('admin') });

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function person(
  email: string,
  role: string,
  extra: Partial<typeof schema.users.$inferInsert> = {},
) {
  const [row] = await ctx.db
    .insert(schema.users)
    .values({ email, role, createdAt: ago(365), updatedAt: ago(1), ...extra })
    .returning();
  return row.id;
}

beforeEach(async () => {
  await resetNotificationsForTests();
  await ctx.db.delete(schema.accessReviewCampaigns);
  await ctx.db.delete(schema.scimUsers);
  await ctx.db.delete(schema.scimConnections);
  await ctx.db.delete(schema.apiTokens);
  await ctx.db.delete(schema.groupGrants);
  await ctx.db.delete(schema.groups);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users);
  invalidateSettingsCache();
  vi.mocked(logAuditEvent).mockClear();

  ids.admin = await person('admin@example.com', 'admin', { lastSignInAt: ago(1) });
  ids.alice = await person('alice@example.com', 'operator', { lastSignInAt: ago(200) });
  ids.bob = await person('bob@example.com', 'user');
  ids.carol = await person('carol@example.com', 'viewer', { status: 'disabled' });
  ids.dave = await person('dave@example.com', 'user', { lastSignInAt: ago(2) });
  ids.eve = await person('eve@example.com', 'viewer', { lastSignInAt: ago(2) });

  const now = new Date().toISOString();
  const [ops] = await ctx.db
    .insert(schema.groups)
    .values({ name: 'Ops', createdAt: now, updatedAt: now })
    .returning();
  const [scim] = await ctx.db
    .insert(schema.groups)
    .values({ name: 'Provisioned', source: 'scim', createdAt: now, updatedAt: now })
    .returning();
  group.ops = ops.id;
  group.scim = scim.id;
  await ctx.db.insert(schema.groupMembers).values([
    { groupId: ops.id, userId: ids.alice, createdAt: now },
    { groupId: ops.id, userId: ids.bob, createdAt: now },
    { groupId: scim.id, userId: ids.dave, createdAt: now },
  ]);
  const [host] = await ctx.db
    .insert(schema.proxyHosts)
    .values({
      name: 'shop',
      domains: JSON.stringify(['shop.example.com']),
      upstreams: JSON.stringify(['app:80']),
      createdAt: now,
      updatedAt: now,
    } as typeof schema.proxyHosts.$inferInsert)
    .returning();
  hostId = host.id;
  await ctx.db
    .insert(schema.groupGrants)
    .values({ groupId: ops.id, proxyHostId: host.id, capability: 'manage', createdAt: now });

  const tokens = await ctx.db
    .insert(schema.apiTokens)
    .values([
      {
        name: 'ci',
        tokenHash: 'h1',
        createdBy: ids.alice,
        createdAt: ago(300),
        lastUsedAt: ago(100),
      },
      {
        name: 'cli',
        tokenHash: 'h2',
        createdBy: ids.admin,
        createdAt: ago(300),
        lastUsedAt: ago(1),
      },
      { name: 'old', tokenHash: 'h3', createdBy: ids.bob, createdAt: ago(300), expiresAt: ago(10) },
    ])
    .returning();
  token.alice = tokens[0].id;
  token.admin = tokens[1].id;
  token.expired = tokens[2].id;
});

describe('a campaign', () => {
  it('snapshots every active account and membership, with hints, and audits it', async () => {
    const campaign = await createCampaign(
      { name: 'Q4', scope: 'allUsers', dueOn: inDays(14), reviewerIds: [ids.dave, ids.alice] },
      ADMIN(),
    );
    expect(campaign).toMatchObject({ name: 'Q4', scope: 'allUsers', status: 'open' });
    const detail = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!;
    const roles = detail.items.filter((item) => item.kind === 'role');
    expect(roles.map((item) => item.subjectLabel).sort()).toEqual([
      'admin@example.com',
      'alice@example.com',
      'bob@example.com',
      'dave@example.com',
      'eve@example.com',
    ]);
    const hint = (email: string) => roles.find((item) => item.subjectLabel === email)!.hints;
    expect(hint('alice@example.com')).toEqual(['noRecentSignIn']);
    expect(hint('bob@example.com')).toEqual(['noRecentSignIn']);
    expect(hint('dave@example.com')).toEqual([]);
    const memberships = detail.items.filter((item) => item.kind === 'membership');
    expect(memberships.map((item) => `${item.subjectLabel}:${item.targetLabel}`).sort()).toEqual([
      'alice@example.com:Ops',
      'bob@example.com:Ops',
      'dave@example.com:Provisioned',
    ]);
    expect(memberships.find((item) => item.targetLabel === 'Provisioned')!.scimManaged).toBe(true);
    // Nobody is handed their own access, and one person's items stay with one reviewer.
    for (const item of detail.items) expect(item.reviewerId).not.toBe(item.userId);
    const alices = detail.items.filter((item) => item.userId === ids.alice);
    expect(new Set(alices.map((item) => item.reviewerId))).toEqual(new Set([ids.dave]));
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        entityType: 'access_review',
        summary: 'Created access review Q4',
      }),
    );
  });

  it('reviews tokens that still work, pointing out one unused for 90 days', async () => {
    const campaign = await createCampaign(
      { name: 'Tokens', scope: 'tokens', dueOn: inDays(3), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const { items } = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!;
    expect(items.map((item) => [item.subjectLabel, item.targetLabel, item.hints])).toEqual([
      ['ci', 'alice@example.com', ['tokenUnused', 'noRecentSignIn']],
      ['cli', 'admin@example.com', []],
    ]);
  });

  it('reviews a role, a group, every grant and every SCIM connection', async () => {
    const operators = await createCampaign(
      {
        name: 'Ops role',
        scope: 'role',
        scopeRef: 'operator',
        dueOn: inDays(3),
        reviewerIds: [ids.dave],
      },
      ADMIN(),
    );
    expect(operators.counts.total).toBe(1);
    const ops = await createCampaign(
      {
        name: 'Ops group',
        scope: 'group',
        scopeRef: String(group.ops),
        dueOn: inDays(3),
        reviewerIds: [ids.dave],
      },
      ADMIN(),
    );
    const { items } = (await getCampaign(ops.id, accessOf('admin', {}, ids.admin)))!;
    expect(items.map((item) => item.kind)).toEqual(['membership', 'membership', 'grant']);
    expect(items[2]).toMatchObject({ targetLabel: 'shop', current: 'manage', objectId: hostId });
    const grants = await createCampaign(
      { name: 'Grants', scope: 'grants', dueOn: inDays(3), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    expect(grants.counts.total).toBe(1);
    expect(
      await failure(
        createCampaign(
          { name: 'SCIM', scope: 'scim', dueOn: inDays(3), reviewerIds: [ids.dave] },
          ADMIN(),
        ),
      ),
    ).toBe('accessReviewEmpty');
    const now = new Date().toISOString();
    await ctx.db.insert(schema.scimConnections).values({
      name: 'IdP',
      tokenHash: 'x',
      tokenHint: 'abcd',
      createdAt: ago(200),
      updatedAt: now,
    });
    const scim = await createCampaign(
      { name: 'SCIM', scope: 'scim', dueOn: inDays(3), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const scimItems = (await getCampaign(scim.id, accessOf('admin', {}, ids.admin)))!.items;
    expect(scimItems).toMatchObject([{ kind: 'scimConnection', hints: ['connectionUnused'] }]);
  });

  it('refuses a bad name, scope, date or reviewer, and anyone who may not manage users', async () => {
    const base = { name: 'X', scope: 'allUsers', dueOn: inDays(1), reviewerIds: [ids.dave] };
    expect(await failure(createCampaign({ ...base, name: ' ' }, ADMIN()))).toBe(
      'accessReviewNameInvalid',
    );
    expect(await failure(createCampaign({ ...base, scope: 'all' }, ADMIN()))).toBe(
      'accessReviewScopeInvalid',
    );
    expect(
      await failure(createCampaign({ ...base, scope: 'role', scopeRef: 'nope' }, ADMIN())),
    ).toBe('accessReviewScopeInvalid');
    expect(
      await failure(createCampaign({ ...base, scope: 'group', scopeRef: '999' }, ADMIN())),
    ).toBe('accessReviewScopeInvalid');
    expect(await failure(createCampaign({ ...base, dueOn: inDays(-2) }, ADMIN()))).toBe(
      'accessReviewDueInvalid',
    );
    expect(await failure(createCampaign({ ...base, dueOn: '2026-02-30' }, ADMIN()))).toBe(
      'accessReviewDueInvalid',
    );
    expect(await failure(createCampaign({ ...base, reviewerIds: [] }, ADMIN()))).toBe(
      'accessReviewReviewersInvalid',
    );
    expect(await failure(createCampaign({ ...base, reviewerIds: [ids.carol] }, ADMIN()))).toBe(
      'accessReviewReviewersInvalid',
    );
    const reader = { userId: ids.dave, capabilities: { 'users:read': 'all' } as CapabilitySet };
    expect(await failure(createCampaign(base, reader))).toBe('accessDenied');
  });

  it('is renamed, given a new date, reassigned and deleted, each audited', async () => {
    const campaign = await createCampaign(
      { name: 'Q4', scope: 'tokens', dueOn: inDays(3), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const updated = await updateCampaign(
      campaign.id,
      { name: 'Q4 tokens', dueOn: inDays(5) },
      ADMIN(),
    );
    expect(updated).toMatchObject({ name: 'Q4 tokens', dueOn: inDays(5) });
    const { items } = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!;
    const alices = items.find((item) => item.userId === ids.alice)!;
    expect(await failure(reassignItems(campaign.id, [alices.id], ids.alice, ADMIN()))).toBe(
      'accessReviewOwnItem',
    );
    expect(await failure(reassignItems(campaign.id, [9999], ids.eve, ADMIN()))).toBe(
      'accessReviewItemNotFound',
    );
    const moved = await reassignItems(campaign.id, [alices.id], ids.eve, ADMIN());
    expect(moved.reviewers.map((reviewer) => reviewer.id).sort()).toEqual(
      [ids.dave, ids.eve].sort(),
    );
    await deleteCampaign(campaign.id, ADMIN());
    expect(await listCampaigns(accessOf('admin', {}, ids.admin))).toEqual([]);
    const actions = vi
      .mocked(logAuditEvent)
      .mock.calls.map(([event]) => (event as { summary: string }).summary);
    expect(actions).toEqual([
      'Created access review Q4',
      'Updated access review Q4 tokens',
      'Reassigned 1 items of access review Q4 tokens',
      'Deleted access review Q4 tokens',
    ]);
  });
});

describe('a reviewer', () => {
  it('sees and decides only the items assigned to them', async () => {
    const campaign = await createCampaign(
      { name: 'Q4', scope: 'allUsers', dueOn: inDays(7), reviewerIds: [ids.dave, ids.eve] },
      ADMIN(),
    );
    const all = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!.items;
    const daves = all.filter((item) => item.reviewerId === ids.dave);
    const eves = all.filter((item) => item.reviewerId === ids.eve);
    expect(daves.length).toBeGreaterThan(0);
    expect(eves.length).toBeGreaterThan(0);

    // A viewer holds no capability, and still reaches their own items.
    const dave = accessOf('user', {}, ids.dave);
    expect((await listCampaigns(dave)).map((entry) => entry.id)).toEqual([campaign.id]);
    const seen = (await getCampaign(campaign.id, dave))!.items;
    expect(seen.map((item) => item.id).sort()).toEqual(daves.map((item) => item.id).sort());

    expect(await failure(decideItem(eves[0].id, { decision: 'keep' }, ids.dave))).toBe(
      'accessReviewItemNotFound',
    );
    const decided = await decideItem(
      daves[0].id,
      { decision: 'keep', note: ' still needed ' },
      ids.dave,
    );
    expect(decided).toMatchObject({ decision: 'keep', note: 'still needed' });

    // Someone who reviews nothing sees nothing.
    const outsider = accessOf('viewer', {}, ids.bob);
    expect(await listCampaigns(outsider)).toEqual([]);
    expect(await getCampaign(campaign.id, outsider)).toBeNull();
    expect(await pendingReviewsFor(ids.dave)).toEqual({
      count: daves.length - 1,
      dueOn: inDays(7),
    });
  });

  it('cannot decide their own access, nor something a decision cannot do', async () => {
    const campaign = await createCampaign(
      { name: 'Q4', scope: 'allUsers', dueOn: inDays(7), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const { items } = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!;
    // The only reviewer's own items fall to the author.
    const own = items.find((item) => item.kind === 'role' && item.userId === ids.dave)!;
    expect(own.reviewerId).toBe(ids.admin);
    await ctx.db
      .update(schema.accessReviewItems)
      .set({ reviewerId: ids.dave })
      .where(eq(schema.accessReviewItems.id, own.id));
    expect(await failure(decideItem(own.id, { decision: 'keep' }, ids.dave))).toBe(
      'accessReviewOwnItem',
    );

    const membership = items.find((item) => item.kind === 'membership' && item.userId === ids.bob)!;
    const role = items.find((item) => item.kind === 'role' && item.userId === ids.bob)!;
    expect(
      await failure(decideItem(membership.id, { decision: 'change', changeTo: 'x' }, ids.dave)),
    ).toBe('accessReviewChangeUnavailable');
    expect(
      await failure(decideItem(role.id, { decision: 'change', changeTo: 'user' }, ids.dave)),
    ).toBe('accessReviewChangeInvalid');
    expect(
      await failure(decideItem(role.id, { decision: 'change', changeTo: 'nope' }, ids.dave)),
    ).toBe('accessReviewChangeInvalid');
    expect(await failure(decideItem(role.id, { decision: 'drop' }, ids.dave))).toBe(
      'accessReviewDecisionInvalid',
    );
    expect(
      await failure(decideItem(role.id, { decision: 'keep', note: 'x'.repeat(501) }, ids.dave)),
    ).toBe('accessReviewNoteTooLong');
  });

  it('has every decision audited, and may change it until the campaign closes', async () => {
    const campaign = await createCampaign(
      { name: 'Q4', scope: 'tokens', dueOn: inDays(7), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const [item] = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!.items;
    vi.mocked(logAuditEvent).mockClear();
    await decideItem(item.id, { decision: 'keep' }, ids.dave);
    await decideItem(item.id, { decision: 'revoke', note: 'unused' }, ids.dave);
    const events = vi
      .mocked(logAuditEvent)
      .mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(events.map((event) => event.summary)).toEqual([
      `Decided keep for item ${item.id} of access review Q4`,
      `Decided revoke for item ${item.id} of access review Q4`,
    ]);
    expect(events[1]).toMatchObject({
      userId: ids.dave,
      action: 'access_review_decision',
      entityType: 'access_review',
      entityId: campaign.id,
      data: expect.objectContaining({ decision: 'revoke', note: 'unused', subject: 'ci' }),
    });
    await closeCampaign(campaign.id, ADMIN());
    expect(await failure(decideItem(item.id, { decision: 'keep' }, ids.dave))).toBe(
      'accessReviewNotOpen',
    );
  });

  it('cannot revoke access a SCIM connection would put back', async () => {
    const now = new Date().toISOString();
    const [connection] = await ctx.db
      .insert(schema.scimConnections)
      .values({ name: 'IdP', tokenHash: 'x', tokenHint: 'abcd', createdAt: now, updatedAt: now })
      .returning();
    await ctx.db.insert(schema.scimUsers).values({
      connectionId: String(connection.id),
      provisioningDomainId: 'cpm',
      userId: ids.bob,
      connectionUserKey: 'k',
      userName: 'bob',
      userNameKey: 'bob',
      primaryEmail: 'bob@example.com',
      workEmailValueIndex: 'bob@example.com',
      emailValueIndex: 'bob@example.com',
      displayName: 'Bob',
      formattedName: 'Bob',
      serializedEmails: '[]',
      active: true,
      orderKey: '1',
      createdAt: now,
      updatedAt: now,
    });
    const campaign = await createCampaign(
      { name: 'Q4', scope: 'allUsers', dueOn: inDays(7), reviewerIds: [ids.eve] },
      ADMIN(),
    );
    const { items } = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!;
    const bobRole = items.find((item) => item.kind === 'role' && item.userId === ids.bob)!;
    const scimMembership = items.find(
      (item) => item.kind === 'membership' && item.groupId === group.scim,
    )!;
    expect(bobRole.scimManaged).toBe(true);
    expect(await failure(decideItem(bobRole.id, { decision: 'revoke' }, ids.eve))).toBe(
      'accessReviewScimManaged',
    );
    expect(await failure(decideItem(scimMembership.id, { decision: 'revoke' }, ids.eve))).toBe(
      'accessReviewScimManaged',
    );
    // Its role is CPM's own, so changing it holds.
    await decideItem(bobRole.id, { decision: 'change', changeTo: 'viewer' }, ids.eve);
    await closeCampaign(campaign.id, ADMIN());
    const [bob] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, ids.bob));
    expect(bob.role).toBe('viewer');
  });
});

describe('closing', () => {
  async function decided(reviewers = [ids.dave, ids.eve]) {
    const campaign = await createCampaign(
      { name: 'Q4', scope: 'allUsers', dueOn: inDays(7), reviewerIds: reviewers },
      ADMIN(),
    );
    const { items } = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!;
    const find = (kind: string, userId: number) =>
      items.find((item) => item.kind === kind && item.userId === userId)!;
    const decide = (item: (typeof items)[number], decision: string, changeTo?: string) =>
      decideItem(item.id, { decision, changeTo }, item.reviewerId!);
    return { campaign, items, find, decide };
  }

  it('applies each revocation and change as the closer', async () => {
    const { campaign, find, decide } = await decided();
    await decide(find('role', ids.bob), 'revoke');
    await decide(find('role', ids.alice), 'change', 'viewer');
    await decide(find('membership', ids.alice), 'revoke');
    await decide(find('role', ids.eve), 'keep');

    const tokens = await createCampaign(
      { name: 'Tokens', scope: 'tokens', dueOn: inDays(7), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const grants = await createCampaign(
      { name: 'Grants', scope: 'grants', dueOn: inDays(7), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const [ci] = (await getCampaign(tokens.id, accessOf('admin', {}, ids.admin)))!.items;
    const [grant] = (await getCampaign(grants.id, accessOf('admin', {}, ids.admin)))!.items;
    await decideItem(ci.id, { decision: 'revoke' }, ids.dave);
    await decideItem(grant.id, { decision: 'change', changeTo: 'view' }, ids.dave);

    const closed = await closeCampaign(campaign.id, ADMIN());
    expect(closed.status).toBe('closed');
    expect(closed.counts).toMatchObject({ revoke: 2, change: 1, keep: 1, applied: 3, failed: 0 });
    await closeCampaign(tokens.id, ADMIN());
    await closeCampaign(grants.id, ADMIN());

    const users = await ctx.db.select().from(schema.users);
    const user = (id: number) => users.find((row) => row.id === id)!;
    expect(user(ids.bob).status).toBe('disabled');
    expect(user(ids.alice).role).toBe('viewer');
    expect(user(ids.eve).status).toBe('active');
    const members = await ctx.db
      .select()
      .from(schema.groupMembers)
      .where(eq(schema.groupMembers.groupId, group.ops));
    expect(members.map((row) => row.userId)).toEqual([ids.bob]);
    expect(
      await ctx.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, token.alice)),
    ).toEqual([]);
    const [kept] = await ctx.db.select().from(schema.groupGrants);
    expect(kept.capability).toBe('view');
    // Nothing applies twice.
    expect(await failure(closeCampaign(campaign.id, ADMIN()))).toBe('accessReviewNotOpen');
    expect(await failure(confirmCampaign(campaign.id, ADMIN()))).toBe('accessReviewNotConfirming');
  });

  it('never does what the closer could not do by hand, and Confirm retries as someone who can', async () => {
    const { campaign, find, decide } = await decided();
    await decide(find('membership', ids.alice), 'revoke');
    await decide(find('role', ids.bob), 'change', 'admin');
    await decide(find('role', ids.admin), 'revoke');
    // Manages users, but not groups, and holds less than an administrator.
    const usersOnly = {
      userId: ids.dave,
      capabilities: { 'users:read': 'all', 'users:write': 'all' } as CapabilitySet,
    };
    const closed = await closeCampaign(campaign.id, usersOnly);
    expect(closed.status).toBe('confirming');
    const { items } = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!;
    const outcome = (kind: string, userId: number) => {
      const item = items.find((entry) => entry.kind === kind && entry.userId === userId)!;
      return [item.outcome, item.outcomeCode];
    };
    expect(outcome('membership', ids.alice)).toEqual(['failed', 'accessDenied']);
    expect(outcome('role', ids.bob)).toEqual(['failed', 'roleExceedsYours']);
    expect(outcome('role', ids.admin)).toEqual(['failed', 'accountExceedsYours']);

    // The administrator may do the first two, but not disable themselves.
    const retried = await confirmCampaign(campaign.id, ADMIN());
    expect(retried.status).toBe('confirming');
    const after = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!.items;
    const state = (kind: string, userId: number) =>
      after.find((entry) => entry.kind === kind && entry.userId === userId)!;
    expect(state('membership', ids.alice).outcome).toBe('applied');
    expect(state('role', ids.bob).outcome).toBe('applied');
    expect(state('role', ids.admin)).toMatchObject({
      outcome: 'failed',
      outcomeCode: 'cannotChangeOwnStatus',
    });
  });

  it('keeps the last active administrator', async () => {
    const other = await person('admin2@example.com', 'admin', { status: 'disabled' });
    const { campaign, find, decide } = await decided();
    await decide(find('role', ids.admin), 'revoke');
    const closed = await closeCampaign(campaign.id, {
      userId: other,
      capabilities: capabilitiesOf('admin'),
    });
    expect(closed.counts.failed).toBe(1);
    const item = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!.items.find(
      (entry) => entry.kind === 'role' && entry.userId === ids.admin,
    )!;
    expect(item.outcomeCode).toBe('lastActiveAdmin');
    const [admin] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, ids.admin));
    expect(admin.status).toBe('active');
  });

  it('holds revocations for an administrator when Settings says so', async () => {
    await saveSettings({ 'config:access_review_confirm_revocations': true });
    const { campaign, find, decide } = await decided();
    await decide(find('role', ids.bob), 'revoke');
    const closed = await closeCampaign(campaign.id, ADMIN());
    expect(closed.status).toBe('confirming');
    const [bob] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, ids.bob));
    expect(bob.status).toBe('active');
    const confirmed = await confirmCampaign(campaign.id, ADMIN());
    expect(confirmed.status).toBe('closed');
    const [after] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, ids.bob));
    expect(after.status).toBe('disabled');
    const summaries = vi
      .mocked(logAuditEvent)
      .mock.calls.map(([event]) => (event as { summary: string }).summary);
    expect(summaries).toContain('Closed access review Q4');
    expect(summaries).toContain('Applied the revocations of access review Q4');
  });

  it('closes with nothing to apply straight away, even when revocations wait', async () => {
    await saveSettings({ 'config:access_review_confirm_revocations': true });
    const { campaign, find, decide } = await decided();
    await decide(find('role', ids.bob), 'keep');
    expect((await closeCampaign(campaign.id, ADMIN())).status).toBe('closed');
  });

  it('records what was gone before it closed', async () => {
    const tokens = await createCampaign(
      { name: 'Tokens', scope: 'tokens', dueOn: inDays(7), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const [ci] = (await getCampaign(tokens.id, accessOf('admin', {}, ids.admin)))!.items;
    await decideItem(ci.id, { decision: 'revoke' }, ids.dave);
    await ctx.db.delete(schema.apiTokens).where(eq(schema.apiTokens.id, token.alice));
    const closed = await closeCampaign(tokens.id, ADMIN());
    expect(closed.status).toBe('closed');
    const [item] = (await getCampaign(tokens.id, accessOf('admin', {}, ids.admin)))!.items;
    expect(item.outcome).toBe('gone');
  });

  it('switches a SCIM connection off rather than deleting it', async () => {
    const now = new Date().toISOString();
    await ctx.db
      .insert(schema.scimConnections)
      .values({ name: 'IdP', tokenHash: 'x', tokenHint: 'abcd', createdAt: now, updatedAt: now });
    const { testDialect } = await import('../../helpers/db');
    const campaign = await createCampaign(
      { name: 'SCIM', scope: 'scim', dueOn: inDays(7), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const [item] = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!.items;
    await decideItem(item.id, { decision: 'revoke' }, ids.dave);
    const closed = await closeCampaign(campaign.id, ADMIN());
    const [connection] = await ctx.db.select().from(schema.scimConnections);
    if (testDialect === 'sqlite') {
      // SCIM needs PostgreSQL, so the connection cannot be written there at all.
      expect(closed.counts.failed).toBe(1);
      expect(connection.enabled).toBe(true);
    } else {
      expect(closed.status).toBe('closed');
      expect(connection.enabled).toBe(false);
    }
  });
});

describe('the CSV export', () => {
  it('has one row per item, matching its decision and outcome', async () => {
    const campaign = await createCampaign(
      { name: 'Tokens', scope: 'tokens', dueOn: inDays(7), reviewerIds: [ids.dave] },
      ADMIN(),
    );
    const [ci, cli] = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!.items;
    await decideItem(ci.id, { decision: 'revoke', note: 'unused, "old"' }, ids.dave);
    await closeCampaign(campaign.id, ADMIN());
    const { items } = (await getCampaign(campaign.id, accessOf('admin', {}, ids.admin)))!;
    const { header, rows } = campaignCsvRows(items, {
      header: (column) => column.toUpperCase(),
      value: (_kind, value) => value,
      reason: (code) => code,
    });
    expect(header[0]).toBe('ITEM');
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((row) => [row[0], row]));
    expect(byId.get(ci.id)).toEqual([
      ci.id,
      'token',
      'ci',
      'alice@example.com',
      null,
      'tokenUnused noRecentSignIn',
      'dave@example.com',
      'revoke',
      null,
      'unused, "old"',
      expect.any(String),
      'applied',
      null,
    ]);
    expect(byId.get(cli.id)?.[7]).toBe('undecided');
  });
});

describe('over GraphQL', () => {
  it('runs a campaign with the same checks', async () => {
    const { accessReviewMutationResolvers: m, accessReviewQueryResolvers: q } = await import(
      '../../../src/lib/graphql/access-reviews'
    );
    const as = (userId: number, role: string) =>
      ({
        viewer: async () => ({ userId, role }),
        access: async () => accessOf(role, {}, userId),
      }) as never;
    const admin = as(ids.admin, 'admin');
    const created = await m.createAccessReview(
      null,
      { input: { name: 'GQL', scope: 'tokens', dueOn: inDays(4), reviewerIds: [ids.dave] } },
      admin,
    );
    expect((await q.accessReviews(null, null, admin)).map((entry) => entry.name)).toEqual(['GQL']);
    await m.updateAccessReview(null, { id: created.id, input: { name: 'GQL 2' } }, admin);
    const detail = (await q.accessReview(null, { id: created.id }, as(ids.dave, 'user')))!;
    expect(detail.items).toHaveLength(2);
    const [first] = detail.items;
    await m.decideAccessReviewItem(
      null,
      { itemId: first.id, decision: 'revoke' },
      as(ids.dave, 'user'),
    );
    await m.reassignAccessReviewItems(
      null,
      { id: created.id, itemIds: [detail.items[1].id], reviewerId: ids.eve },
      admin,
    );
    const closed = await m.closeAccessReview(null, { id: created.id }, admin);
    expect(closed.status).toBe('closed');
    expect(await failure(m.confirmAccessReview(null, { id: created.id }, admin))).toBe(
      'accessReviewNotConfirming',
    );
    expect(await m.deleteAccessReview(null, { id: created.id }, admin)).toBe(true);
  });
});
