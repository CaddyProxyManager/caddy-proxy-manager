/** Every WAF server action refuses a signed-in user without security or host rights, and writes nothing. */
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
  checkCrsPluginUpdatesAction,
  checkCrsRegistryNowAction,
  deleteWafExclusionAction,
  deleteWafPresetAction,
  getWafEventDetailAction,
  installCrsPluginAction,
  listCrsRegistryAction,
  retryCrsPluginAction,
  reviewWafEventAction,
  saveCrsPluginConfigAction,
  saveCrsRegistrySettingsAction,
  saveWafExclusionAction,
  saveWafPresetAction,
  setHostWafEnabledAction,
  uninstallCrsPluginAction,
  updateCrsPluginAction,
} from '@/src/app/(dashboard)/waf/actions';
import { wafExclusions, wafPresets } from '@/src/lib/db/schema';
import { domainErrorMessage } from '@/src/lib/errors/domain-error';
import { form, seedUser } from '../../helpers/settings-actions';

type Call = [name: string, run: () => Promise<{ status: string; message?: string }>];

const calls: Call[] = [
  ['setHostWafEnabled', () => setHostWafEnabledAction(1, true)],
  ['saveWafPreset', () => saveWafPresetAction({ status: 'idle' } as never, form({ name: 'p' }))],
  ['deleteWafPreset', () => deleteWafPresetAction(1)],
  ['listCrsRegistry', () => listCrsRegistryAction()],
  ['checkCrsRegistryNow', () => checkCrsRegistryNowAction()],
  ['saveCrsRegistrySettings', () => saveCrsRegistrySettingsAction({} as never)],
  ['installCrsPlugin', () => installCrsPluginAction('registry', 'plugin')],
  ['checkCrsPluginUpdates', () => checkCrsPluginUpdatesAction()],
  ['updateCrsPlugin', () => updateCrsPluginAction(1)],
  ['saveCrsPluginConfig', () => saveCrsPluginConfigAction(1, null)],
  ['uninstallCrsPlugin', () => uninstallCrsPluginAction(1)],
  ['retryCrsPlugin', () => retryCrsPluginAction(1, 'plugin')],
  ['saveWafExclusion', () => saveWafExclusionAction(null, {} as never)],
  ['deleteWafExclusion', () => deleteWafExclusionAction(1)],
  ['getWafEventDetail', () => getWafEventDetailAction('key')],
  ['reviewWafEvent', () => reviewWafEventAction('key', null)],
];

describe('WAF actions without the rights for them', () => {
  let seeded = 0;
  beforeEach(async () => {
    ctx.session = { user: await seedUser(ctx.db, `user${++seeded}@example.com`, 'user') };
  });

  for (const [name, run] of calls) {
    it(`${name} is refused`, async () => {
      const result = await run();
      expect(result).toMatchObject({
        status: 'error',
        message: domainErrorMessage('accessDenied'),
      });
    });
  }

  it('leaves no preset or exclusion behind', async () => {
    for (const [, run] of calls) await run();
    expect(await ctx.db.select().from(wafPresets)).toEqual([]);
    expect(await ctx.db.select().from(wafExclusions)).toEqual([]);
  });
});
