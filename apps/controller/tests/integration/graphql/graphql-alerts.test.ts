/**
 * Alert channels, rules, history and digests over GraphQL: written and read back, secrets never
 * answered, a generated signing secret answered once, and every field refused to a non-admin.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { capabilitiesOf } from '@/tests/helpers/access';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { graphql } from 'graphql';
import { schema } from '../../../src/lib/graphql/schema';
import type { GraphQLContext } from '../../../src/lib/graphql/context';
import * as db from '../../../src/lib/db/schema';
import { resetNotificationsForTests } from '../../../src/lib/notifications';

function contextFor(role: string): GraphQLContext {
  return {
    viewer: async () => ({ userId: 1, role, authMethod: 'bearer' as const }),
    access: async () => ({
      userId: 1,
      role,
      capabilities: capabilitiesOf(role),
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
    rawBody: async () => '',
    request: {} as never,
  };
}

async function run(document: string, role = 'admin', variableValues?: Record<string, unknown>) {
  return graphql({ schema, source: document, contextValue: contextFor(role), variableValues });
}

async function ok<T = Record<string, unknown>>(document: string, vars?: Record<string, unknown>) {
  const result = await run(document, 'admin', vars);
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

beforeEach(async () => {
  ctx.db = await createTestDb();
  await resetNotificationsForTests();
  const now = new Date().toISOString();
  await ctx.db.insert(db.users).values({
    id: 1,
    email: 'admin@example.com',
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as typeof db.users.$inferInsert);
});

describe('alerts over GraphQL', () => {
  it('creates a webhook channel, answering its generated secret once and never its URL', async () => {
    const created = await ok<{
      createAlertChannel: { id: number; target: string; signingSecret: string | null };
    }>(
      `mutation ($c: AlertChannelInput!) {
        createAlertChannel(input: $c) { id target signingSecret hasSigningSecret }
      }`,
      { c: { name: 'ops', kind: 'webhook', url: 'https://hooks.example.com/abc/token?x=1' } },
    );
    expect(created.createAlertChannel.signingSecret).toMatch(/^whsec_/);
    expect(created.createAlertChannel.target).toBe('https://hooks.example.com/…');

    const listed = await ok<{
      alertChannels: { name: string; builtin: string | null; signingSecret: null }[];
    }>('{ alertChannels { name builtin signingSecret target } }');
    expect(listed.alertChannels.map((channel) => channel.name)).toEqual(['email', 'push', 'ops']);
    expect(JSON.stringify(listed)).not.toContain('token');
    expect(listed.alertChannels.every((channel) => channel.signingSecret === null)).toBe(true);

    const refused = await run(
      `mutation ($c: AlertChannelInput!) { createAlertChannel(input: $c) { id } }`,
      'admin',
      { c: { name: 'bad', kind: 'discord', url: 'http://discord.example.com/x' } },
    );
    expect(refused.errors?.[0].message).toContain('https');
  });

  it('creates, silences and deletes a rule, and lists history and digests', async () => {
    const { createAlertChannel } = await ok<{ createAlertChannel: { id: number } }>(
      `mutation ($c: AlertChannelInput!) { createAlertChannel(input: $c) { id } }`,
      { c: { name: 'chat', kind: 'slack', url: 'https://hooks.slack.com/services/T/B/x' } },
    );
    const { createAlertRule } = await ok<{ createAlertRule: { id: number; config: unknown } }>(
      `mutation ($r: AlertRuleInput!) { createAlertRule(input: $r) { id config scope tags } }`,
      {
        r: {
          name: '5xx',
          source: 'metric',
          metric: 'serverErrorShare',
          threshold: 5,
          minutes: 10,
          scope: 'tags',
          tags: ['prod'],
          channelIds: [createAlertChannel.id],
        },
      },
    );
    expect(createAlertRule.config).toEqual({
      metric: 'serverErrorShare',
      comparison: 'above',
      threshold: 5,
      minutes: 10,
    });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const silenced = await ok<{ silenceAlertRule: { silencedUntil: string } }>(
      'mutation ($id: Int!, $until: String) { silenceAlertRule(id: $id, until: $until) { silencedUntil } }',
      { id: createAlertRule.id, until },
    );
    expect(silenced.silenceAlertRule.silencedUntil).toBe(until);
    const queued = await ok<{ testAlertRule: number }>(
      'mutation ($id: Int!) { testAlertRule(id: $id) }',
      { id: createAlertRule.id },
    );
    expect(queued.testAlertRule).toBeGreaterThan(0);
    const history = await ok<{
      alertHistory: { kind: string; deliveries: { status: string }[] }[];
    }>('{ alertHistory { kind deliveries { status channelName } } }');
    expect(history.alertHistory).toMatchObject([
      { kind: 'ruleTest', deliveries: [{ status: 'pending' }] },
    ]);

    const digest = await ok<{ createAlertDigest: { id: number; nextRunAt: string | null } }>(
      `mutation ($d: AlertDigestInput!) { createAlertDigest(input: $d) { id } }`,
      {
        d: {
          name: 'daily',
          time: '07:30',
          timeZone: 'Europe/Berlin',
          channelIds: [createAlertChannel.id],
        },
      },
    );
    const digests = await ok<{ alertDigests: { name: string; nextRunAt: string }[] }>(
      '{ alertDigests { name time timeZone nextRunAt lastRun { id } } }',
    );
    expect(digests.alertDigests).toMatchObject([{ name: 'daily' }]);
    expect(Date.parse(digests.alertDigests[0].nextRunAt)).toBeGreaterThan(Date.now());
    expect(
      (
        await run(
          `mutation ($d: AlertDigestInput!) { createAlertDigest(input: $d) { id } }`,
          'admin',
          {
            d: { name: 'bad', time: '25:00', channelIds: [createAlertChannel.id] },
          },
        )
      ).errors,
    ).toBeDefined();
    await ok('mutation ($id: Int!) { deleteAlertDigest(id: $id) }', {
      id: digest.createAlertDigest.id,
    });
    await ok('mutation ($id: Int!) { deleteAlertRule(id: $id) }', { id: createAlertRule.id });
  });

  it('refuses every alert field to a non-admin', async () => {
    for (const document of [
      '{ alertChannels { id } }',
      '{ alertRules { id } }',
      '{ alertHistory { id } }',
      '{ alertDigests { id } }',
    ]) {
      const result = await run(document, 'user');
      expect(result.errors?.length).toBeGreaterThan(0);
    }
  });
});
