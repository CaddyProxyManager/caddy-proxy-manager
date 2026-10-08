/**
 * Settings and backups are delegable, and neither may be a way to become an administrator: a
 * sign-in source hands out only roles its writer holds and links accounts only for whoever holds
 * everything, and taking or restoring a backup is for whoever holds everything.
 */
import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { BUILT_IN_ROLES } from '../../../src/lib/roles/built-in';
import { type Capability, capabilitySetOf } from '../../../src/lib/roles/capabilities';
import { createRole } from '../../../src/lib/roles/store';
import { assertMayConfigureSignIn } from '../../../src/lib/roles/sign-in-sources';
import { accessFor, can } from '../../../src/lib/users/permissions';
import type { DomainError } from '../../../src/lib/errors/domain-error';

const ADMIN = { userId: 1, role: 'admin', capabilities: capabilitySetOf([BUILT_IN_ROLES.admin]) };
const SETTINGS = capabilitySetOf([
  { key: 'settings', capabilities: ['settings:read', 'settings:write'], scoped: false },
]);

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as DomainError).code;
  }
}

describe('sign-in sources', () => {
  it('refuses a default role or mapping above the writer', async () => {
    expect(await code(assertMayConfigureSignIn(SETTINGS, null, { defaultRole: 'admin' }))).toBe(
      'roleExceedsYours',
    );
    expect(await code(assertMayConfigureSignIn(SETTINGS, null, { adminGroup: 'admins' }))).toBe(
      'roleExceedsYours',
    );
    expect(
      await code(assertMayConfigureSignIn(SETTINGS, null, { roleGroups: { operator: ['ops'] } })),
    ).toBe('roleExceedsYours');
    expect(
      await code(
        assertMayConfigureSignIn(SETTINGS, null, { defaultRole: 'viewer', adminGroup: '' }),
      ),
    ).toBeNull();
    expect(
      await code(assertMayConfigureSignIn(ADMIN.capabilities, null, { defaultRole: 'admin' })),
    ).toBeNull();
  });

  it('refuses linking to anyone not holding everything', async () => {
    expect(await code(assertMayConfigureSignIn(SETTINGS, null, { autoLink: true }))).toBe(
      'signInLinkNeedsEverything',
    );
    expect(
      await code(assertMayConfigureSignIn(ADMIN.capabilities, null, { autoLink: true })),
    ).toBeNull();
  });

  it('judges an update by what the source hands out once saved', async () => {
    const admins = { defaultRole: 'user', roleGroups: { admin: ['admins'] }, autoLink: false };
    // Repointing a source an administrator set up is handing out what it hands out.
    expect(await code(assertMayConfigureSignIn(SETTINGS, admins, { name: 'x' }))).toBe(
      'roleExceedsYours',
    );
    expect(await code(assertMayConfigureSignIn(SETTINGS, admins, { adminGroup: null }))).toBeNull();
    expect(
      await code(
        assertMayConfigureSignIn(
          SETTINGS,
          { ...admins, roleGroups: {}, autoLink: true },
          {
            name: 'x',
          },
        ),
      ),
    ).toBe('signInLinkNeedsEverything');
    // The list's switch alone.
    expect(await code(assertMayConfigureSignIn(SETTINGS, admins, { enabled: false }))).toBeNull();
  });

  it('allows a made role the writer covers', async () => {
    const auditors = await createRole({ name: 'Auditors', capabilities: ['audit:read'] }, ADMIN);
    const holding = capabilitySetOf([
      { key: 'x', capabilities: ['settings:write', 'audit:read'], scoped: false },
    ]);
    expect(
      await code(assertMayConfigureSignIn(holding, null, { defaultRole: auditors.key })),
    ).toBeNull();
    expect(
      await code(assertMayConfigureSignIn(SETTINGS, null, { defaultRole: auditors.key })),
    ).toBe('roleExceedsYours');
  });
});

describe('backups:write', () => {
  it('counts only for a caller holding everything', async () => {
    const everything = BUILT_IN_ROLES.admin.capabilities as Capability[];
    const backups = await createRole(
      { name: 'Backups', capabilities: ['backups:read', 'backups:write'] },
      ADMIN,
    );
    const all = await createRole({ name: 'Everything', capabilities: everything }, ADMIN);

    const partial = await accessFor(7, backups.key);
    expect(can(partial, 'backups:read')).toBe(true);
    expect(can(partial, 'backups:write')).toBe(false);
    expect(can(await accessFor(8, all.key), 'backups:write')).toBe(true);
    expect(can(await accessFor(9, 'admin'), 'backups:write')).toBe(true);
  });
});
