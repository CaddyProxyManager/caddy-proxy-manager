/**
 * What provisioning does to CPM: accounts made, linked, changed, disabled with everything they
 * signed in with, groups landing as CPM groups with their mapped roles, and connections that
 * neither take nor stand in for API tokens.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { eq } from 'drizzle-orm';
import { testDialect } from '@/tests/helpers/db';
import {
  GROUP_SCHEMA,
  USER_SCHEMA,
  bootScim,
  registerScimCleanup,
} from '@/tests/helpers/scim-harness';

registerScimCleanup();
// Each test boots Better Auth on a fresh database, which a loaded parallel run makes slow.
setDefaultTimeout(30_000);

type Harness = Awaited<ReturnType<typeof bootScim>>;

async function accountOf(h: Harness, email: string) {
  const [row] = await h.db.select().from(h.schema.users).where(eq(h.schema.users.email, email));
  return row;
}

async function signedInWith(h: Harness, userId: number) {
  const now = new Date().toISOString();
  await h.db.insert(h.schema.sessions).values({
    userId,
    token: `session-${userId}-${Math.random()}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  });
  const tokens = await import('@/src/lib/models/api-tokens');
  return (await tokens.createApiToken('script', userId)).rawToken;
}

async function holdings(h: Harness, userId: number) {
  const sessions = await h.db
    .select()
    .from(h.schema.sessions)
    .where(eq(h.schema.sessions.userId, userId));
  const tokens = await h.db
    .select()
    .from(h.schema.apiTokens)
    .where(eq(h.schema.apiTokens.createdBy, userId));
  return { sessions: sessions.length, tokens: tokens.length };
}

async function cpmGroups(h: Harness) {
  const rows = await h.db.select().from(h.schema.groups);
  return rows.map((row: { name: string; source: string; role: string | null }) => ({
    name: row.name,
    source: row.source,
    role: row.role,
  }));
}

async function memberNames(h: Harness, groupName: string) {
  const rows = await h.db
    .select({ email: h.schema.users.email })
    .from(h.schema.groupMembers)
    .innerJoin(h.schema.groups, eq(h.schema.groups.id, h.schema.groupMembers.groupId))
    .innerJoin(h.schema.users, eq(h.schema.users.id, h.schema.groupMembers.userId))
    .where(eq(h.schema.groups.name, groupName));
  return rows.map((row: { email: string }) => row.email).sort();
}

describe.skipIf(testDialect === 'sqlite')('SCIM users', () => {
  it('creates an account, replaces and patches it, with filtered paths', async () => {
    const h = await bootScim();
    const created = await h.createUser('life@example.com', { displayName: 'Life' });
    const id = created.body.id;
    expect((await accountOf(h, 'life@example.com')).name).toBe('Life');

    const replaced = await h.call('PUT', `/Users/${id}`, {
      schemas: [USER_SCHEMA],
      userName: 'life@example.com',
      displayName: 'Life Replaced',
      emails: [{ value: 'life@example.com', primary: true, type: 'work' }],
      active: true,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.displayName).toBe('Life Replaced');

    const patched = await h.patch(`/Users/${id}`, [
      { op: 'replace', path: 'emails[type eq "work"].value', value: 'work@example.com' },
      {
        op: 'add',
        path: 'phoneNumbers',
        value: [
          { value: '+1 555 0100', type: 'work' },
          { value: '+1 555 0199', type: 'mobile' },
        ],
      },
      { op: 'remove', path: 'phoneNumbers[type eq "mobile"]' },
      { op: 'replace', path: 'phoneNumbers[type eq "work"].value', value: '+1 555 0101' },
      { op: 'add', path: 'title', value: 'Engineer' },
    ]);
    expect(patched.status).toBe(200);
    expect(patched.body.emails.map((email: { value: string }) => email.value)).toEqual([
      'work@example.com',
    ]);
    expect(patched.body.phoneNumbers).toEqual([{ value: '+1 555 0101', type: 'work' }]);
    expect(patched.body.title).toBe('Engineer');
    expect((await accountOf(h, 'work@example.com'))?.id).toBeDefined();

    const removed = await h.patch(`/Users/${id}`, [{ op: 'remove', path: 'title' }]);
    expect(removed.body.title).toBeUndefined();
  });

  it('deprovisions by PATCH active false, revoking sessions and API tokens', async () => {
    const h = await bootScim();
    const created = await h.createUser('leaver@example.com');
    const account = await accountOf(h, 'leaver@example.com');
    const apiToken = await signedInWith(h, account.id);
    expect(await holdings(h, account.id)).toEqual({ sessions: 1, tokens: 1 });

    // The shape some identity providers send: a capitalised op and a string boolean.
    const answer = await h.patch(`/Users/${created.body.id}`, [
      { op: 'Replace', path: 'active', value: 'False' },
    ]);
    expect(answer.status).toBe(200);
    expect(answer.body.active).toBe(false);
    expect((await accountOf(h, 'leaver@example.com')).status).toBe('disabled');
    expect(await holdings(h, account.id)).toEqual({ sessions: 0, tokens: 0 });
    const tokens = await import('@/src/lib/models/api-tokens');
    expect(await tokens.validateToken(apiToken)).toBeNull();

    const back = await h.patch(`/Users/${created.body.id}`, [
      { op: 'replace', value: { active: 'True' } },
    ]);
    expect(back.body.active).toBe(true);
    expect((await accountOf(h, 'leaver@example.com')).status).toBe('active');
  });

  it('disables an account the identity provider deletes', async () => {
    const h = await bootScim();
    const created = await h.createUser('deleted@example.com');
    const account = await accountOf(h, 'deleted@example.com');
    await signedInWith(h, account.id);
    expect((await h.call('DELETE', `/Users/${created.body.id}`)).status).toBe(204);
    expect((await h.call('GET', `/Users/${created.body.id}`)).status).toBe(404);
    expect((await accountOf(h, 'deleted@example.com')).status).toBe('disabled');
    expect(await holdings(h, account.id)).toEqual({ sessions: 0, tokens: 0 });
  });

  it('links an account that already has the email, keeping its profile', async () => {
    const h = await bootScim();
    const users = await import('@/src/lib/models/user');
    const existing = await users.createUser({
      email: 'existing@example.com',
      name: 'Kept Name',
      provider: 'credentials',
      subject: 'existing@example.com',
      role: 'operator',
    });
    const linked = await h.createUser('existing@example.com', { displayName: 'IdP Name' });
    expect(linked.status).toBe(201);
    const rows = await h.db.select().from(h.schema.users);
    expect(rows).toHaveLength(2);
    const account = await accountOf(h, 'existing@example.com');
    expect(account.id).toBe(existing.id);
    expect(account.name).toBe('Kept Name');
    expect(account.role).toBe('operator');
  });

  it('refuses an existing email when the connection does not link', async () => {
    const h = await bootScim({ linkExisting: false });
    const users = await import('@/src/lib/models/user');
    await users.createUser({
      email: 'mine@example.com',
      provider: 'credentials',
      subject: 'mine@example.com',
    });
    const refused = await h.createUser('mine@example.com');
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await h.db.select().from(h.schema.scimUsers)).toEqual([]);
  });
});

describe.skipIf(testDialect === 'sqlite')('SCIM groups', () => {
  it('land as scim groups with the mapped role, and follow renames and members', async () => {
    const h = await bootScim({ roleGroups: { operator: ['Platform'] } });
    const a = await h.createUser('a@example.com');
    const b = await h.createUser('b@example.com');

    const platform = await h.createGroup('Platform', [a.body.id, b.body.id]);
    const other = await h.createGroup('Readers', [a.body.id]);
    expect(platform.status).toBe(201);
    expect(other.status).toBe(201);
    expect(await cpmGroups(h)).toEqual(
      expect.arrayContaining([
        { name: 'Platform', source: 'scim', role: 'operator' },
        { name: 'Readers', source: 'scim', role: null },
      ]),
    );
    expect(await memberNames(h, 'Platform')).toEqual(['a@example.com', 'b@example.com']);

    await h.patch(`/Groups/${platform.body.id}`, [
      { op: 'remove', path: `members[value eq "${b.body.id}"]` },
    ]);
    expect(await memberNames(h, 'Platform')).toEqual(['a@example.com']);

    await h.patch(`/Groups/${other.body.id}`, [
      { op: 'replace', path: 'displayName', value: 'Platform Readers' },
    ]);
    expect(await cpmGroups(h)).toContainEqual({
      name: 'Platform Readers',
      source: 'scim',
      role: null,
    });

    // A mapping change reaches groups already there.
    await h.connections.updateScimConnection(
      h.connection!.id,
      { name: 'Test IdP', roleGroups: { viewer: ['Platform Readers'] } },
      h.actor,
    );
    expect(await cpmGroups(h)).toEqual(
      expect.arrayContaining([
        { name: 'Platform', source: 'scim', role: null },
        { name: 'Platform Readers', source: 'scim', role: 'viewer' },
      ]),
    );
  });

  it('mirrors an empty group and removes a deleted one', async () => {
    const h = await bootScim();
    const empty = await h.call('POST', '/Groups', {
      schemas: [GROUP_SCHEMA],
      displayName: 'Empty',
    });
    expect(empty.status).toBe(201);
    expect(await cpmGroups(h)).toEqual([{ name: 'Empty', source: 'scim', role: null }]);
    expect((await h.call('DELETE', `/Groups/${empty.body.id}`)).status).toBe(204);
    expect(await cpmGroups(h)).toEqual([]);
  });

  it('audits each write against its connection', async () => {
    const h = await bootScim();
    const { logAuditEvent } = await import('@/src/lib/audit');
    const { vi } = await import('@/tests/helpers/vi');
    vi.mocked(logAuditEvent).mockClear();
    await h.createUser('audited@example.com');
    await h.createGroup('Audited');
    const summaries = vi
      .mocked(logAuditEvent)
      .mock.calls.map(([event]) => (event as { summary: string }).summary);
    expect(summaries).toContain('SCIM connection Test IdP created user audited@example.com');
    expect(summaries).toContain('SCIM connection Test IdP created group Audited');
  });
});

describe.skipIf(testDialect === 'sqlite')('SCIM connections and API tokens', () => {
  it('do not stand in for each other', async () => {
    const h = await bootScim();
    const tokens = await import('@/src/lib/models/api-tokens');
    const { rawToken } = await tokens.createApiToken('full', h.owner.id);
    expect((await h.call('GET', '/Users', undefined, rawToken)).status).toBe(401);
    expect(await tokens.validateToken(h.token as string)).toBeNull();
  });

  it('refuse a disabled connection and a rotated-out token', async () => {
    const h = await bootScim();
    const id = h.connection!.id;
    const rotated = await h.connections.rotateScimConnectionToken(id, h.actor);
    expect((await h.call('GET', '/Users')).status).toBe(401);
    expect((await h.call('GET', '/Users', undefined, rotated.token)).status).toBe(200);

    await h.connections.updateScimConnection(id, { name: 'Test IdP', enabled: false }, h.actor);
    expect((await h.call('GET', '/Users', undefined, rotated.token)).status).toBe(401);
  });

  it('when deleted, hand their groups to the Groups page and keep their accounts', async () => {
    const h = await bootScim();
    const user = await h.createUser('stays@example.com');
    await h.createGroup('Stays', [user.body.id]);
    await h.connections.deleteScimConnection(h.connection!.id, h.actor);

    expect((await h.call('GET', '/Users')).status).toBe(401);
    expect(await cpmGroups(h)).toEqual([{ name: 'Stays', source: 'ui', role: null }]);
    expect(await memberNames(h, 'Stays')).toEqual(['stays@example.com']);
    expect((await accountOf(h, 'stays@example.com')).status).toBe('active');
    expect(await h.connections.listScimConnections()).toEqual([]);
  });
});
