/** Saved analytics views: per user, optionally shared, owner-only changes, capped and audited. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { accessOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const schema = await import('../../../src/lib/db/schema');
const {
  MAX_ANALYTICS_VIEWS_PER_USER,
  createAnalyticsView,
  deleteAnalyticsView,
  listAnalyticsViews,
  normalizeViewQuery,
  updateAnalyticsView,
} = await import('../../../src/lib/models/analytics-views');
const { resolvers: raw } = await import('../../../src/lib/graphql/resolvers');
const { withRequirements } = await import('../../../src/lib/graphql/token-scope');
// As served: the role check is the wrapper's, not each resolver's.
const resolvers = {
  Query: withRequirements('Query', raw.Query),
  Mutation: withRequirements('Mutation', raw.Mutation),
};
type GraphQLContext = import('../../../src/lib/graphql/context').GraphQLContext;

const NOW = new Date().toISOString();
const ANN = 1;
const BOB = 2;

function contextFor(userId: number, role = 'admin'): GraphQLContext {
  return {
    viewer: async () => ({ userId, role, authMethod: 'session' }),
    access: async () => accessOf(role, {}, userId),
  } as unknown as GraphQLContext;
}

// The preload replaces the audit module with a mock, so the calls are what to read.
const audit = vi.mocked((await import('../../../src/lib/audit')).logAuditEvent);

function auditActions() {
  return audit.mock.calls
    .map(([event]) => event)
    .filter((event) => event.entityType === 'analytics_view')
    .map((event) => [event.action, event.summary]);
}

beforeEach(async () => {
  await ctx.db.delete(schema.analyticsViews);
  audit.mockClear();
  await ctx.db.delete(schema.users).catch(() => {});
  for (const [id, name] of [
    [ANN, 'Ann'],
    [BOB, 'Bob'],
  ] as const) {
    await ctx.db.insert(schema.users).values({
      id,
      email: `${name.toLowerCase()}@example.com`,
      name,
      role: 'admin',
      provider: 'credentials',
      subject: name,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
});

describe('normalizeViewQuery', () => {
  it('stores the query as the page would write it', () => {
    expect(normalizeViewQuery('?range=24h&f=status:is:5XX&f=bogus:is:x&junk=1')).toBe(
      'f=status%3Ais%3A5xx',
    );
  });
});

describe('analytics views', () => {
  it('creates, lists, renames, re-saves and deletes, auditing each', async () => {
    const view = await createAnalyticsView(ANN, { name: '  Errors  ', query: 'range=7d' });
    expect(view).toMatchObject({ name: 'Errors', query: 'range=7d', shared: false, own: true });

    const renamed = await updateAnalyticsView(ANN, view.id, { name: 'Server errors' });
    expect(renamed.name).toBe('Server errors');
    const resaved = await updateAnalyticsView(ANN, view.id, { query: 'range=1h&group=status' });
    expect(resaved.query).toBe('range=1h&group=status');

    await deleteAnalyticsView(ANN, view.id);
    expect(await listAnalyticsViews(ANN)).toEqual([]);
    expect(auditActions()).toEqual([
      ['create', 'Created analytics view Errors'],
      ['update', 'Renamed analytics view Errors to Server errors'],
      ['update', 'Updated analytics view Server errors'],
      ['delete', 'Deleted analytics view Server errors'],
    ]);
  });

  it("lists another administrator's view only once it is shared, and never lets them change it", async () => {
    const view = await createAnalyticsView(ANN, { name: 'Mine', query: '' });
    expect(await listAnalyticsViews(BOB)).toEqual([]);

    await updateAnalyticsView(ANN, view.id, { shared: true });
    const [seen] = await listAnalyticsViews(BOB);
    expect(seen).toMatchObject({ name: 'Mine', own: false, ownerName: 'Ann', shared: true });

    await expect(updateAnalyticsView(BOB, view.id, { name: 'Taken' })).rejects.toMatchObject({
      code: 'analyticsViewNotFound',
    });
    await expect(deleteAnalyticsView(BOB, view.id)).rejects.toMatchObject({
      code: 'analyticsViewNotFound',
    });
  });

  it('needs a name, and not a long one', async () => {
    await expect(createAnalyticsView(ANN, { name: '  ', query: '' })).rejects.toMatchObject({
      code: 'analyticsViewNameRequired',
    });
    await expect(
      createAnalyticsView(ANN, { name: 'x'.repeat(81), query: '' }),
    ).rejects.toMatchObject({ code: 'analyticsViewNameTooLong' });
  });

  it(`stops at ${MAX_ANALYTICS_VIEWS_PER_USER} views per user`, async () => {
    await ctx.db.insert(schema.analyticsViews).values(
      Array.from({ length: MAX_ANALYTICS_VIEWS_PER_USER }, (_, i) => ({
        userId: ANN,
        name: `View ${i}`,
        query: '',
        shared: false,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );
    await expect(createAnalyticsView(ANN, { name: 'One more', query: '' })).rejects.toMatchObject({
      code: 'analyticsViewLimit',
    });
    // The cap is per user.
    await expect(createAnalyticsView(BOB, { name: 'Fine', query: '' })).resolves.toBeDefined();
  });

  it('goes with its owner', async () => {
    await createAnalyticsView(BOB, { name: 'Gone soon', query: '', shared: true });
    await ctx.db.delete(schema.users);
    expect(await ctx.db.select().from(schema.analyticsViews)).toEqual([]);
  });
});

describe('over GraphQL', () => {
  it('manages the caller own views', async () => {
    const created = await resolvers.Mutation.createAnalyticsView(
      null,
      { name: 'Via API', query: 'range=30d', shared: true },
      contextFor(ANN),
    );
    expect(created).toMatchObject({ name: 'Via API', query: 'range=30d', shared: true });

    const listed = await resolvers.Query.analyticsViews(null, {}, contextFor(BOB));
    expect(listed.map((view) => view.name)).toEqual(['Via API']);

    await expect(
      resolvers.Mutation.deleteAnalyticsView(null, { id: created.id }, contextFor(BOB)),
    ).rejects.toMatchObject({ code: 'analyticsViewNotFound' });
    expect(
      await resolvers.Mutation.deleteAnalyticsView(null, { id: created.id }, contextFor(ANN)),
    ).toBe(true);
  });

  it('is for administrators only', async () => {
    await expect(resolvers.Query.analyticsViews(null, {}, contextFor(ANN, 'user'))).rejects.toThrow(
      "This account's role does not allow this request",
    );
    await expect(
      resolvers.Query.trafficSignals(null, {}, contextFor(ANN, 'operator')),
    ).rejects.toThrow("This account's role does not allow this request");
  });

  it('reports signals as unavailable with analytics off, not as all clear', async () => {
    const result = await resolvers.Query.trafficSignals(null, {}, contextFor(ANN));
    expect(result.available).toBe(false);
    expect(result.signals).toEqual([]);
  });
});
