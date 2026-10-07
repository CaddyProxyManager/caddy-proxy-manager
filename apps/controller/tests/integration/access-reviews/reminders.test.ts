/**
 * Access review reminders reach the alert channels: once as a campaign nears its due date with
 * items undecided, once more when it is overdue, and once when a closed campaign waits for an
 * administrator's confirmation. A campaign with nothing left undecided says nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
import { createRule } from '../../../src/lib/alerts/rule-store';
import { flushNotifications, resetNotificationsForTests } from '../../../src/lib/notifications';
import { BATCH_MS } from '../../../src/lib/notifications/plan';
import { encryptSecret } from '../../../src/lib/secrets';
import { invalidateSettingsCache, saveSettings } from '../../../src/lib/settings/resolve';
import { createCampaign, decideItem, getCampaign } from '../../../src/lib/access-reviews';
import { closeCampaign } from '../../../src/lib/access-reviews/apply';
import { dueAt } from '../../../src/lib/access-reviews/model';
import { watchAccessReviews } from '../../../src/lib/access-reviews/reminders';
import { accessOf, capabilitiesOf } from '../../helpers/access';

const DAY = 86_400_000;
let server: ReturnType<typeof Bun.serve>;
let posts: string[] = [];
let admin = 0;
let reviewer = 0;

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
  delete process.env.SMTP_HOST;
  posts = [];
  await resetNotificationsForTests();
  await ctx.db.delete(schema.accessReviewCampaigns);
  await ctx.db.delete(schema.apiTokens);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users);
  invalidateSettingsCache();
  const now = new Date().toISOString();
  const people = await ctx.db
    .insert(schema.users)
    .values([
      { email: 'admin@example.com', role: 'admin', createdAt: now, updatedAt: now },
      { email: 'rev@example.com', role: 'user', createdAt: now, updatedAt: now },
    ])
    .returning();
  admin = people[0].id;
  reviewer = people[1].id;
  await ctx.db.insert(schema.apiTokens).values([
    { name: 'one', tokenHash: 'a', createdBy: admin, createdAt: now },
    { name: 'two', tokenHash: 'b', createdBy: admin, createdAt: now },
  ]);
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
      name: 'reviews',
      source: 'event',
      kinds: ['accessReviewDue', 'accessReviewOverdue', 'accessReviewConfirm'],
      channelIds: [channel.id],
    },
    admin,
  );
});

async function campaign(days: number) {
  return createCampaign(
    {
      name: 'Quarterly',
      scope: 'tokens',
      dueOn: new Date(Date.now() + days * DAY).toISOString().slice(0, 10),
      reviewerIds: [reviewer],
    },
    { userId: admin, capabilities: capabilitiesOf('admin') },
  );
}

describe('access review reminders', () => {
  it('tell the channels once as the due date nears, and once when it has passed', async () => {
    const made = await campaign(10);
    const due = dueAt(made.dueOn);
    // Outside the default three days nothing is said.
    await watchAccessReviews(due - 5 * DAY);
    await flushNotifications(due - 5 * DAY + BATCH_MS);
    expect(posts).toEqual([]);

    await watchAccessReviews(due - 2 * DAY);
    await flushNotifications(due - 2 * DAY + BATCH_MS);
    await watchAccessReviews(due - DAY);
    await flushNotifications(due - DAY + BATCH_MS);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('Quarterly');
    expect(posts[0]).toContain('2 items');

    await watchAccessReviews(due + DAY);
    await flushNotifications(due + DAY + BATCH_MS);
    await watchAccessReviews(due + 2 * DAY);
    await flushNotifications(due + 2 * DAY + BATCH_MS);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain('overdue');
  });

  it('follow the reminder setting, and stop once everything is decided', async () => {
    await saveSettings({ 'config:access_review_reminder_days': 10 });
    const made = await campaign(20);
    const { items } = (await getCampaign(made.id, accessOf('admin', {}, admin)))!;
    for (const item of items) await decideItem(item.id, { decision: 'keep' }, reviewer);
    const due = dueAt(made.dueOn);
    await watchAccessReviews(due - 5 * DAY);
    await watchAccessReviews(due + DAY);
    await flushNotifications(due + DAY + BATCH_MS);
    expect(posts).toEqual([]);
  });

  it('tell the channels when a closed review waits for confirmation', async () => {
    await saveSettings({ 'config:access_review_confirm_revocations': true });
    const made = await campaign(5);
    const { items } = (await getCampaign(made.id, accessOf('admin', {}, admin)))!;
    await decideItem(items[0].id, { decision: 'revoke' }, reviewer);
    await closeCampaign(made.id, { userId: admin, capabilities: capabilitiesOf('admin') });
    await flushNotifications(Date.now() + BATCH_MS);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('waits for confirmation');
  });
});
