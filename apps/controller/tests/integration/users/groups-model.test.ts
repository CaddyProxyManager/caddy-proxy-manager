/**
 * Groups against a real database: members come back with the user they name, every write is
 * audited, and a missing group or member is a domain error rather than a silent no-op.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// A Bun mock factory must be synchronous; an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { eq } from 'drizzle-orm';
import {
  addGroupMember,
  countGroups,
  createGroup,
  deleteGroup,
  getGroup,
  getGroupsForUser,
  listGroups,
  removeGroupMember,
  updateGroup,
} from '../../../src/lib/models/groups';
import { logAuditEvent } from '../../../src/lib/audit';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { groupMembers, groups, users } from '../../../src/lib/db/schema';

const NOW = '2026-03-01T00:00:00.000Z';

async function seedUser(email: string, name: string | null = null): Promise<number> {
  const [row] = await ctx.db
    .insert(users)
    .values({ email, name, createdAt: NOW, updatedAt: NOW })
    .returning({ id: users.id });
  return row.id;
}

/** setup.bun.ts replaces logAuditEvent with a mock. */
function auditRows() {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
}

let actor: number;

beforeEach(async () => {
  vi.mocked(logAuditEvent).mockClear();
  await ctx.db.delete(groupMembers);
  await ctx.db.delete(groups);
  await ctx.db.delete(users);
  actor = await seedUser('admin@example.com', 'Admin');
});

describe('createGroup', () => {
  it('stores a trimmed name, starts empty and audits the creation', async () => {
    const group = await createGroup({ name: '  Ops  ', description: 'On call' }, actor);

    expect(group).toMatchObject({ name: 'Ops', description: 'On call', source: 'ui', members: [] });
    expect(Date.parse(group.createdAt)).not.toBeNaN();
    const [row] = await ctx.db.select().from(groups).where(eq(groups.id, group.id));
    expect(row.createdBy).toBe(actor);
    expect(auditRows()).toEqual([
      expect.objectContaining({
        userId: actor,
        action: 'create',
        entityType: 'group',
        entityId: group.id,
      }),
    ]);
  });

  it('defaults a missing description to null', async () => {
    expect((await createGroup({ name: 'Plain' }, actor)).description).toBeNull();
  });
});

describe('listGroups and countGroups', () => {
  it('lists nothing for no groups', async () => {
    expect(await listGroups()).toEqual([]);
    expect(await countGroups()).toBe(0);
  });

  it('orders by name and gives each group only its own members', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const bob = await seedUser('bob@example.com');
    const zeta = await createGroup({ name: 'Zeta' }, actor);
    const alpha = await createGroup({ name: 'Alpha' }, actor);
    await createGroup({ name: 'Middle' }, actor);
    await addGroupMember(zeta.id, alice, actor);
    await addGroupMember(alpha.id, bob, actor);
    await addGroupMember(alpha.id, alice, actor);

    const listed = await listGroups();

    expect(listed.map((group) => group.name)).toEqual(['Alpha', 'Middle', 'Zeta']);
    expect(listed[0].members.map((member) => member.email).sort()).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(listed[1].members).toEqual([]);
    expect(listed[2].members).toEqual([
      expect.objectContaining({ userId: alice, email: 'alice@example.com', name: 'Alice' }),
    ]);
    expect(await countGroups()).toBe(3);
  });
});

describe('getGroup', () => {
  it('answers null for a group that does not exist', async () => {
    expect(await getGroup(9999)).toBeNull();
  });
});

describe('updateGroup', () => {
  it('changes only what it is given', async () => {
    const group = await createGroup({ name: 'Ops', description: 'On call' }, actor);

    const renamed = await updateGroup(group.id, { name: 'Operations' }, actor);
    expect(renamed).toMatchObject({ name: 'Operations', description: 'On call' });

    const cleared = await updateGroup(group.id, { description: null }, actor);
    expect(cleared).toMatchObject({ name: 'Operations', description: null });

    expect(auditRows().filter((event) => event.action === 'update')).toHaveLength(2);
  });

  it('refuses a group that does not exist, without auditing', async () => {
    expect(await codeOf(updateGroup(9999, { name: 'x' }, actor))).toBe('groupNotFound');
    expect(auditRows()).toEqual([]);
  });
});

describe('deleteGroup', () => {
  it('removes the group and its memberships but not the users', async () => {
    const alice = await seedUser('alice@example.com');
    const group = await createGroup({ name: 'Ops' }, actor);
    await addGroupMember(group.id, alice, actor);

    await deleteGroup(group.id, actor);

    expect(await getGroup(group.id)).toBeNull();
    expect(await ctx.db.select().from(groupMembers)).toEqual([]);
    expect(await ctx.db.select().from(users).where(eq(users.id, alice))).toHaveLength(1);
    expect(auditRows().at(-1)).toMatchObject({
      action: 'delete',
      entityType: 'group',
      entityId: group.id,
    });
  });

  it('refuses a group that does not exist', async () => {
    expect(await codeOf(deleteGroup(9999, actor))).toBe('groupNotFound');
  });
});

describe('membership', () => {
  it('adds and removes a member, auditing each against the group', async () => {
    const alice = await seedUser('alice@example.com', 'Alice');
    const group = await createGroup({ name: 'Ops' }, actor);

    const added = await addGroupMember(group.id, alice, actor);
    expect(added.members.map((member) => member.userId)).toEqual([alice]);
    expect(await getGroupsForUser(alice)).toEqual([{ id: group.id, name: 'Ops' }]);

    const removed = await removeGroupMember(group.id, alice, actor);
    expect(removed.members).toEqual([]);
    expect(await getGroupsForUser(alice)).toEqual([]);

    const memberEvents = auditRows().filter((event) => event.entityType === 'group_member');
    expect(memberEvents.map((event) => [event.action, event.entityId])).toEqual([
      ['create', group.id],
      ['delete', group.id],
    ]);
  });

  it('refuses to add to or remove from a group that does not exist', async () => {
    const alice = await seedUser('alice@example.com');
    expect(await codeOf(addGroupMember(9999, alice, actor))).toBe('groupNotFound');
    expect(await codeOf(removeGroupMember(9999, alice, actor))).toBe('groupNotFound');
  });

  it('refuses to remove someone who is not a member', async () => {
    const alice = await seedUser('alice@example.com');
    const group = await createGroup({ name: 'Ops' }, actor);
    vi.mocked(logAuditEvent).mockClear();

    expect(await codeOf(removeGroupMember(group.id, alice, actor))).toBe('memberNotFoundInGroup');
    expect(auditRows()).toEqual([]);
  });

  it("lists every group a user is in, and none of anyone else's", async () => {
    const alice = await seedUser('alice@example.com');
    const bob = await seedUser('bob@example.com');
    const ops = await createGroup({ name: 'Ops' }, actor);
    const dev = await createGroup({ name: 'Dev' }, actor);
    await addGroupMember(ops.id, alice, actor);
    await addGroupMember(dev.id, alice, actor);
    await addGroupMember(dev.id, bob, actor);

    const aliceGroups = (await getGroupsForUser(alice)).map((group) => group.name).sort();
    expect(aliceGroups).toEqual(['Dev', 'Ops']);
    expect(await getGroupsForUser(bob)).toEqual([{ id: dev.id, name: 'Dev' }]);
  });
});
