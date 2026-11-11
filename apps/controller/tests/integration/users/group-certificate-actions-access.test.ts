/** Every group and certificate server action refuses a signed-in user without the rights, and writes nothing. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  session: null as null | { user: import('../../helpers/settings-actions').SessionUser },
}));

ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const actualAuth = await import('@/src/lib/auth');
vi.mock('@/src/lib/auth', () => ({
  ...actualAuth,
  auth: vi.fn(async () => ctx.session),
}));

import {
  addGroupMemberAction,
  addGroupMembersAction,
  createGroupAction,
  deleteGroupAction,
  removeGroupMemberAction,
  setGroupGrantsAction,
  setGroupMappingsAction,
  setGroupRoleAction,
  updateGroupAction,
} from '@/src/app/(dashboard)/groups/actions';
import {
  createCertificateAction,
  createCertificateFromFilesAction,
  deleteCertificateAction,
  deleteUnusedCertificatesAction,
  listCertificateFilesAction,
  rereadCertificateFileAction,
  updateCertificateAction,
} from '@/src/app/(dashboard)/certificates/actions';
import { certificates, groups } from '@/src/lib/db/schema';
import { domainErrorMessage } from '@/src/lib/errors/domain-error';
import { form, seedUser } from '../../helpers/settings-actions';

type Call = [name: string, run: () => Promise<{ ok: boolean; error?: string }>];

const calls: Call[] = [
  ['createGroup', () => createGroupAction(form({ name: 'g' }))],
  ['updateGroup', () => updateGroupAction(1, form({ name: 'g' }))],
  ['deleteGroup', () => deleteGroupAction(1)],
  ['addGroupMember', () => addGroupMemberAction(1, 1)],
  ['addGroupMembers', () => addGroupMembersAction(1, [1])],
  ['removeGroupMember', () => removeGroupMemberAction(1, 1)],
  ['setGroupMappings', () => setGroupMappingsAction(1, [])],
  ['setGroupGrants', () => setGroupGrantsAction(1, [])],
  ['setGroupRole', () => setGroupRoleAction(1, 'admin')],
  ['createCertificate', () => createCertificateAction(form({ name: 'c' }))],
  ['updateCertificate', () => updateCertificateAction(1, form({ name: 'c' }))],
  ['deleteCertificate', () => deleteCertificateAction(1)],
  ['listCertificateFiles', () => listCertificateFilesAction(1)],
  [
    'createCertificateFromFiles',
    () =>
      createCertificateFromFilesAction({ name: 'c', agentRowId: 1, certPath: 'a', keyPath: 'b' }),
  ],
  ['rereadCertificateFile', () => rereadCertificateFileAction(1)],
  ['deleteUnusedCertificates', () => deleteUnusedCertificatesAction([1])],
];

describe('group and certificate actions without the rights for them', () => {
  let seeded = 0;
  beforeEach(async () => {
    ctx.session = { user: await seedUser(ctx.db, `user${++seeded}@example.com`, 'user') };
  });

  for (const [name, run] of calls) {
    it(`${name} is refused`, async () => {
      expect(await run()).toEqual({ ok: false, error: domainErrorMessage('accessDenied') });
    });
  }

  it('leaves no group or certificate behind', async () => {
    for (const [, run] of calls) await run();
    expect(await ctx.db.select().from(groups)).toEqual([]);
    expect(await ctx.db.select().from(certificates)).toEqual([]);
  });
});
