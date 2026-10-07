/**
 * The gate the SCIM plugin had to pass before CPM adopted it: create, PATCH and deactivate through
 * its real routes, and a failure part-way through a transaction leaving nothing behind. PostgreSQL
 * only: under bun:sqlite the same failure left the account it had created (see the W7 report).
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { eq } from 'drizzle-orm';
import { testDialect } from '@/tests/helpers/db';
import { bootScim, registerScimCleanup } from '@/tests/helpers/scim-harness';

registerScimCleanup();
// Each test boots Better Auth on a fresh database, which a loaded parallel run makes slow.
setDefaultTimeout(30_000);

describe.skipIf(testDialect === 'sqlite')('SCIM plugin gate', () => {
  it('creates, patches and deactivates an account', async () => {
    const h = await bootScim();
    const created = await h.createUser('gate@example.com');
    expect(created.status).toBe(201);

    const renamed = await h.patch(`/Users/${created.body.id}`, [
      { op: 'replace', path: 'displayName', value: 'Gate Keeper' },
    ]);
    expect(renamed.status).toBe(200);
    expect(renamed.body.displayName).toBe('Gate Keeper');

    const deactivated = await h.patch(`/Users/${created.body.id}`, [
      { op: 'Replace', path: 'active', value: 'False' },
    ]);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.active).toBe(false);
    const [account] = await h.db
      .select({ status: h.schema.users.status })
      .from(h.schema.users)
      .where(eq(h.schema.users.email, 'gate@example.com'));
    expect(account.status).toBe('disabled');
  });

  it('leaves nothing behind when a group fails part-way through its transaction', async () => {
    const h = await bootScim();
    const member = await h.createUser('member@example.com');
    // Made on the Groups page: the projection, inside the plugin's transaction, refuses the name.
    const groupsModel = await import('@/src/lib/models/groups');
    await groupsModel.createGroup({ name: 'Taken' }, h.owner.id);

    const failed = await h.createGroup('Taken', [member.body.id]);
    expect(failed.status).toBe(409);
    expect(failed.body.scimType).toBe('uniqueness');

    expect(await h.db.select().from(h.schema.scimGroups)).toEqual([]);
    expect(await h.db.select().from(h.schema.scimGroupMembers)).toEqual([]);
    expect(await h.db.select().from(h.schema.scimProjectionGrants)).toEqual([]);
    const groups = await h.db.select().from(h.schema.groups);
    expect(
      groups.map((group: { name: string; source: string }) => [group.name, group.source]),
    ).toEqual([['Taken', 'ui']]);
  });

  it('leaves the account as it was when deactivating it fails part-way through', async () => {
    // The only administrator, linked by email; disabling them is refused inside the transaction.
    const h = await bootScim();
    const linked = await h.createUser('owner@example.com');
    expect(linked.status).toBe(201);

    const refused = await h.patch(`/Users/${linked.body.id}`, [
      { op: 'replace', path: 'active', value: false },
    ]);
    expect(refused.status).toBe(400);
    expect(refused.body.scimType).toBe('mutability');

    const [owner] = await h.db
      .select({ status: h.schema.users.status })
      .from(h.schema.users)
      .where(eq(h.schema.users.id, h.owner.id));
    expect(owner.status).toBe('active');
    const [scimUser] = await h.db.select().from(h.schema.scimUsers);
    expect(scimUser.active).toBe(true);
    expect((await h.call('GET', `/Users/${linked.body.id}`)).body.active).toBe(true);
  });
});
