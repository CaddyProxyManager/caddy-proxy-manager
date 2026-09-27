/**
 * A narrowed view sees exactly what its role and groups grant, never outlives its expiry or its
 * owner's admin role, and can't name groups that don't exist.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  sqlite: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  },
}));

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { setGroupGrants } from '../../src/lib/models/group-grants';
import { canCreate, canView, resolveAccess } from '../../src/lib/permissions';
import { readViewAs, startViewAs, stopViewAs, VIEW_AS_DURATION_MS } from '../../src/lib/view-as';
import * as schema from '../../src/lib/db/schema';

const NOW = new Date().toISOString();
const ADMIN = 1;
const SESSION = 1;

beforeEach(async () => {
  await ctx.db.delete(schema.groupGrants);
  await ctx.db.delete(schema.groupMembers);
  await ctx.db.delete(schema.groups);
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.sessions);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: ADMIN,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db.insert(schema.sessions).values({
    id: SESSION,
    userId: ADMIN,
    token: 'token',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db.insert(schema.proxyHosts).values(
    [1, 2].map((id) => ({
      id,
      name: `host-${id}`,
      domains: `["h${id}.example.com"]`,
      upstreams: '["up:80"]',
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
  await ctx.db
    .insert(schema.groups)
    .values(
      [10, 20].map((id) => ({ id, name: `g${id}`, source: 'ui', createdAt: NOW, updatedAt: NOW })),
    );
  await setGroupGrants(10, [{ resource: { kind: 'proxyHost', id: 1 }, capability: 'manage' }]);
  await setGroupGrants(20, [{ resource: { kind: 'proxyHost', id: 2 }, capability: 'view' }]);
});

describe('readViewAs', () => {
  const live = { viewAsRole: 'operator', viewAsGroupIds: '[10]', viewAsExpiresAt: '' };
  const future = new Date(Date.now() + 60_000).toISOString();

  it('reads a live view on an admin session', () => {
    expect(readViewAs({ ...live, viewAsExpiresAt: future }, 'admin')).toEqual({
      role: 'operator',
      groupIds: [10],
      expiresAt: future,
    });
  });

  it('ignores it once expired, off an admin, or for a role that is not offered', () => {
    const past = new Date(Date.now() - 1).toISOString();
    expect(readViewAs({ ...live, viewAsExpiresAt: past }, 'admin')).toBeNull();
    expect(readViewAs({ ...live, viewAsExpiresAt: future }, 'operator')).toBeNull();
    expect(
      readViewAs({ ...live, viewAsRole: 'admin', viewAsExpiresAt: future }, 'admin'),
    ).toBeNull();
  });

  it('narrows unreadable group ids to none', () => {
    expect(
      readViewAs({ ...live, viewAsGroupIds: 'not json', viewAsExpiresAt: future }, 'admin')
        ?.groupIds,
    ).toEqual([]);
  });
});

describe('access while viewing', () => {
  const viewing = (groupIds: number[], role = 'operator') => ({
    user: { id: String(ADMIN), email: 'admin@example.com', name: null, role },
    viewAs: { role: role as 'operator', groupIds, expiresAt: '' },
    realRole: 'admin',
  });

  it("sees what the chosen groups grant, and nothing the admin's own memberships do", async () => {
    await ctx.db.insert(schema.groupMembers).values({ groupId: 20, userId: ADMIN, createdAt: NOW });
    const access = await resolveAccess(viewing([10]));
    expect(access.isAdmin).toBe(false);
    expect(canView(access, 'proxyHost', 1)).toBe(true);
    expect(canView(access, 'proxyHost', 2)).toBe(false);
    expect(canCreate(access)).toBe(false);
  });

  it('gives a viewer nothing, groups or not', async () => {
    const access = await resolveAccess(viewing([10], 'viewer'));
    expect(canView(access, 'proxyHost', 1)).toBe(false);
  });
});

describe('startViewAs and stopViewAs', () => {
  it('stores the view for an hour, and clears it', async () => {
    const now = Date.now();
    const view = await startViewAs(SESSION, 'operator', [10, 10, 20], now);
    expect(view.groupIds.sort()).toEqual([10, 20]);
    expect(Date.parse(view.expiresAt)).toBe(now + VIEW_AS_DURATION_MS);

    const [row] = await ctx.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, SESSION));
    expect(readViewAs(row, 'admin', now)?.role).toBe('operator');

    await stopViewAs(SESSION);
    const [cleared] = await ctx.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, SESSION));
    expect(readViewAs(cleared, 'admin', now)).toBeNull();
  });

  it('refuses admin, an unknown role, and a group that does not exist', async () => {
    await expect(startViewAs(SESSION, 'admin', [])).rejects.toMatchObject({
      code: 'viewAsRoleInvalid',
    });
    await expect(startViewAs(SESSION, 'root', [])).rejects.toMatchObject({
      code: 'viewAsRoleInvalid',
    });
    await expect(startViewAs(SESSION, 'operator', [999])).rejects.toMatchObject({
      code: 'viewAsGroupMissing',
    });
  });
});
