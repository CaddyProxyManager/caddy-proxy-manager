/**
 * SCIM connections as an administrator manages them, from the page or GraphQL: who may issue
 * one, what a mapping may hand out, and what is audited.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { testDialect } from '@/tests/helpers/db';
import { capabilitiesOf } from '@/tests/helpers/access';
import { bootScim, registerScimCleanup } from '@/tests/helpers/scim-harness';
import { vi } from '@/tests/helpers/vi';
import { DomainError } from '@/src/lib/errors/domain-error';

registerScimCleanup();
// Each test boots Better Auth on a fresh database, which a loaded parallel run makes slow.
setDefaultTimeout(30_000);

async function codeOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
}

describe.skipIf(testDialect === 'sqlite')('SCIM connections', () => {
  it('validate their name', async () => {
    const h = await bootScim();
    const { createScimConnection } = h.connections;
    expect(await codeOf(createScimConnection({ name: ' ' }, h.actor))).toBe(
      'scimConnectionNameRequired',
    );
    expect(await codeOf(createScimConnection({ name: 'x'.repeat(101) }, h.actor))).toBe(
      'scimConnectionNameTooLong',
    );
    expect(await codeOf(createScimConnection({ name: 'Test IdP' }, h.actor))).toBe(
      'scimConnectionNameTaken',
    );
    expect(await codeOf(h.connections.updateScimConnection(999, { name: 'x' }, h.actor))).toBe(
      'scimConnectionNotFound',
    );
  });

  it('are issued only by whoever may change both users and groups', async () => {
    const h = await bootScim();
    const operator = { userId: h.owner.id, capabilities: capabilitiesOf('operator') };
    expect(await codeOf(h.connections.createScimConnection({ name: 'Other' }, operator))).toBe(
      'scimConnectionNeedsUsersAndGroups',
    );
    expect(await codeOf(h.connections.rotateScimConnectionToken(h.connection!.id, operator))).toBe(
      'scimConnectionNeedsUsersAndGroups',
    );
    expect(await codeOf(h.connections.deleteScimConnection(h.connection!.id, operator))).toBe(
      'scimConnectionNeedsUsersAndGroups',
    );
  });

  it('never map a group to admin, nor to a role the issuer does not hold', async () => {
    const h = await bootScim();
    expect(
      await codeOf(
        h.connections.createScimConnection(
          { name: 'A', roleGroups: { admin: ['Admins'] } },
          h.actor,
        ),
      ),
    ).toBe('groupRoleAdmin');
    const usersAndGroups = {
      userId: h.owner.id,
      capabilities: {
        'users:write': 'all',
        'users:read': 'all',
        'groups:write': 'all',
        'groups:read': 'all',
      } as const,
    };
    expect(
      await codeOf(
        h.connections.createScimConnection(
          { name: 'B', roleGroups: { operator: ['Ops'] } },
          usersAndGroups,
        ),
      ),
    ).toBe('roleExceedsYours');
  });

  it('keep their mapping when an update leaves it out, and count as a role in use', async () => {
    const h = await bootScim({ roleGroups: { viewer: ['Readers'] } });
    const id = h.connection!.id;
    const updated = await h.connections.updateScimConnection(id, { name: 'Renamed' }, h.actor);
    expect(updated.name).toBe('Renamed');
    expect(updated.roleGroups).toEqual({ viewer: ['Readers'] });

    const { createRole, deleteRole } = await import('@/src/lib/roles/store');
    const role = await createRole(
      { name: 'Auditors', capabilities: ['audit:read'], scoped: false },
      h.actor,
    );
    await h.connections.updateScimConnection(
      id,
      { name: 'Renamed', roleGroups: { [role.key]: ['Auditors'] } },
      h.actor,
    );
    expect(await codeOf(deleteRole(role.key, { ...h.actor, role: 'admin' }))).toBe('roleInUse');
  });

  it('answer the token once and audit each change', async () => {
    const h = await bootScim();
    const { logAuditEvent } = await import('@/src/lib/audit');
    vi.mocked(logAuditEvent).mockClear();
    const made = await h.connections.createScimConnection({ name: 'Audited' }, h.actor);
    expect(made.token.startsWith('cpm_scim_')).toBe(true);
    expect(made.connection.tokenHint).toBe(made.token.slice(-4));
    expect(JSON.stringify(await h.connections.listScimConnections())).not.toContain(made.token);
    await h.connections.updateScimConnection(made.connection.id, { name: 'Audited 2' }, h.actor);
    await h.connections.rotateScimConnectionToken(made.connection.id, h.actor);
    await h.connections.deleteScimConnection(made.connection.id, h.actor);
    const summaries = vi
      .mocked(logAuditEvent)
      .mock.calls.map(([event]) => (event as { summary: string }).summary);
    expect(summaries).toEqual([
      'Created SCIM connection Audited',
      'Updated SCIM connection Audited 2',
      'Rotated the token of SCIM connection Audited 2',
      'Deleted SCIM connection Audited 2',
    ]);
  });

  it('are reachable over GraphQL', async () => {
    const h = await bootScim();
    const { scimMutationResolvers, scimQueryResolvers } = await import('@/src/lib/graphql/scim');
    const context = {
      viewer: async () => ({ userId: h.owner.id, role: 'admin' }),
      access: async () => ({ capabilities: h.actor.capabilities }),
    } as never;
    const made = await scimMutationResolvers.createScimConnection(
      null,
      { input: { name: 'GraphQL' } },
      context,
    );
    const id = made.connection.id;
    expect((await scimQueryResolvers.scimConnections()).map((c) => c.name)).toContain('GraphQL');
    const updated = await scimMutationResolvers.updateScimConnection(
      null,
      { id, input: { name: 'GraphQL 2', linkExisting: false } },
      context,
    );
    expect(updated.linkExisting).toBe(false);
    const rotated = await scimMutationResolvers.rotateScimConnectionToken(null, { id }, context);
    expect(rotated.token).not.toBe(made.token);
    expect(await scimMutationResolvers.deleteScimConnection(null, { id }, context)).toBe(true);
  });
});

describe.skipIf(testDialect !== 'sqlite')('SCIM under SQLite', () => {
  it('answers 501 and refuses to issue a connection', async () => {
    const h = await bootScim();
    const answer = await h.call('GET', '/Users', undefined, 'cpm_scim_anything');
    expect(answer.status).toBe(501);
    expect(answer.body).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '501',
    });
    expect(answer.contentType).toContain('application/scim+json');
    expect(await codeOf(h.connections.createScimConnection({ name: 'Nope' }, h.actor))).toBe(
      'scimNeedsPostgres',
    );
    expect(await h.connections.listScimConnections()).toEqual([]);
  });
});
