/**
 * The overview's setup checklist: steps detected from what the instance holds, marked done or the
 * list hidden by an administrator, stored once per instance and audited, and the same over GraphQL.
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

const schema = await import('../../../src/lib/db/schema');
const checklist = await import('../../../src/lib/setup-checklist');
const { resolvers: raw } = await import('../../../src/lib/graphql/resolvers');
const { withRequirements } = await import('../../../src/lib/graphql/token-scope');
// As served: the role check is the wrapper's, not each resolver's.
const resolvers = {
  Query: withRequirements('Query', raw.Query),
  Mutation: withRequirements('Mutation', raw.Mutation),
};
const { settingsHref } = await import('../../../src/app/(dashboard)/settings/sections');
type GraphQLContext = import('../../../src/lib/graphql/context').GraphQLContext;

const audit = vi.mocked((await import('../../../src/lib/audit')).logAuditEvent);
const NOW = new Date().toISOString();

function contextFor(role: string): GraphQLContext {
  return {
    viewer: async () => ({ userId: 1, role, authMethod: 'session' }),
    access: async () => ({
      userId: 1,
      role,
      capabilities: capabilitiesOf(role),
      grants: { proxyHosts: new Map(), l4ProxyHosts: new Map(), agents: new Map() },
    }),
  } as unknown as GraphQLContext;
}

async function addUser(id: number) {
  await ctx.db.insert(schema.users).values({
    id,
    email: `user${id}@example.com`,
    name: `User ${id}`,
    role: 'admin',
    provider: 'credentials',
    subject: `user${id}`,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  audit.mockClear();
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users);
  await addUser(1);
});

describe('normalizeChecklistState', () => {
  it('drops unknown steps and keeps the known ones in order', () => {
    expect(
      checklist.normalizeChecklistState({ hidden: 'yes', done: ['sso', 'bogus', 'certificate'] }),
    ).toEqual({ hidden: false, done: ['certificate', 'sso'] });
    expect(checklist.normalizeChecklistState(null)).toEqual({ hidden: false, done: [] });
  });
});

describe('detection', () => {
  it('ticks a step once the instance has it', async () => {
    let found = await checklist.detectSetupSteps();
    expect(found.proxyHost).toBe(false);
    expect(found.secondUser).toBe(false);

    await addUser(2);
    await ctx.db.insert(schema.proxyHosts).values({
      name: 'App',
      domains: JSON.stringify(['app.example.com']),
      upstreams: JSON.stringify(['http://app:8080']),
      createdAt: NOW,
      updatedAt: NOW,
    } as typeof schema.proxyHosts.$inferInsert);
    found = await checklist.detectSetupSteps();
    expect(found.proxyHost).toBe(true);
    expect(found.secondUser).toBe(true);
    expect(found.certificate).toBe(false);
  });
});

describe('marking and hiding', () => {
  it('stores a step marked done, keeps detection separate, and audits both ways', async () => {
    await checklist.setSetupStepDone('sso', true, 1);
    let list = await checklist.getSetupChecklist();
    expect(list.steps.find((s) => s.step === 'sso')).toEqual({
      step: 'sso',
      detected: false,
      markedDone: true,
    });

    await checklist.setSetupStepDone('sso', false, 1);
    list = await checklist.getSetupChecklist();
    expect(list.steps.find((s) => s.step === 'sso')?.markedDone).toBe(false);
    expect(audit.mock.calls.map(([event]) => event.summary)).toEqual([
      'Marked setup step sso done',
      'Marked setup step sso not done',
    ]);
  });

  it('refuses a step that does not exist', async () => {
    await expect(checklist.setSetupStepDone('nope', true, 1)).rejects.toMatchObject({
      code: 'setupStepUnknown',
    });
  });

  it('hides the list for the whole instance', async () => {
    await checklist.setSetupChecklistHidden(true, 1);
    expect((await checklist.getSetupChecklist()).hidden).toBe(true);
    await checklist.setSetupChecklistHidden(false, 1);
    expect((await checklist.getChecklistState()).hidden).toBe(false);
    expect(audit.mock.calls.map(([event]) => event.entityType)).toEqual([
      'setup_checklist',
      'setup_checklist',
    ]);
  });
});

describe('over GraphQL', () => {
  it('reads and changes the checklist as an administrator', async () => {
    const admin = contextFor('admin');
    const state = await resolvers.Mutation.setSetupStepDone(
      null,
      { step: 'analytics', done: true },
      admin,
    );
    expect(state.done).toEqual(['analytics']);
    const list = await resolvers.Query.setupChecklist(null, {}, admin);
    expect(list.steps.map((s) => s.step)).toEqual([...checklist.SETUP_STEPS]);
    expect(
      (await resolvers.Mutation.setSetupChecklistHidden(null, { hidden: true }, admin)).hidden,
    ).toBe(true);
  });

  it('refuses everyone else', async () => {
    await expect(
      resolvers.Query.setupChecklist(null, {}, contextFor('operator')),
    ).rejects.toThrow();
    await expect(
      resolvers.Mutation.setSetupChecklistHidden(null, { hidden: true }, contextFor('user')),
    ).rejects.toThrow();
  });

  it('answers Needs attention with English text beside the code', async () => {
    const list = await resolvers.Query.attention(null, {}, contextFor('admin'));
    expect(Array.isArray(list.items)).toBe(true);
    for (const item of list.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.title.startsWith('attention.')).toBe(false);
    }
  });
});

describe('step links', () => {
  it('send the settings steps where the settings page puts them', () => {
    expect(checklist.SETUP_STEP_HREF.analytics).toBe(settingsHref('analytics'));
    expect(checklist.SETUP_STEP_HREF.sso).toBe(settingsHref('oauth'));
  });
});
