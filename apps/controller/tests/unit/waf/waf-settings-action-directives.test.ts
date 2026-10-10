/**
 * The global WAF form refuses directives the config would drop, as the host and REST paths do,
 * rather than reporting success for rules that never apply. Only what a save newly drops counts,
 * so a stored rule a later release started dropping does not block saving other fields.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock, testTranslator } from '@/tests/helpers/next-intl';
import type { WafSettings } from '@/src/lib/settings';

vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  requireUser: vi.fn(async () => ({ user: { id: '1', role: 'admin' } })),
}));

const { getWafSettingsMock, saveWafSettingsMock } = vi.hoisted(() => ({
  getWafSettingsMock: vi.fn<() => Promise<WafSettings | null>>(async () => null),
  saveWafSettingsMock: vi.fn<(settings: WafSettings) => Promise<void>>(async () => {}),
}));

vi.mock('@/src/lib/settings', () => ({
  clearSetting: vi.fn(),
  getSetting: vi.fn(),
  saveCloudflareSettings: vi.fn(),
  getDnsProviderSettings: vi.fn(),
  saveDnsProviderSettings: vi.fn(),
  saveGeneralSettings: vi.fn(),
  saveAuthentikSettings: vi.fn(),
  saveMetricsSettings: vi.fn(),
  saveLoggingSettings: vi.fn(),
  saveDnsSettings: vi.fn(),
  saveUpstreamDnsResolutionSettings: vi.fn(),
  saveGeoBlockSettings: vi.fn(),
  saveWafSettings: saveWafSettingsMock,
  getWafSettings: getWafSettingsMock,
}));
vi.mock('@/src/lib/settings/staging', () => ({
  discardAllStaged: vi.fn(),
  discardStagedKey: vi.fn(),
  stageWrites: vi.fn(async () => {}),
  stagedOverlay: vi.fn(async () => new Map()),
}));
vi.mock('@/src/lib/settings/staging-context', () => ({
  withCapturedWrites: async (_overlay: unknown, action: () => Promise<unknown>) => ({
    result: await action(),
    writes: new Map(),
  }),
}));
vi.mock('@/src/lib/caddy', () => ({ applyCaddyConfig: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/src/lib/models/waf-events', () => ({ getWafRuleMessages: vi.fn() }));
vi.mock('@/src/lib/dns/providers', () => ({ getProviderDefinition: vi.fn(), DNS_PROVIDERS: [] }));
vi.mock('@/src/lib/dns/provider-credentials', () => ({ encryptProviderCredentials: vi.fn() }));

import { updateWafSettingsAction } from '@/src/app/(dashboard)/settings/actions';

const DROPPED_RULE = 'SecRule ARGS "@pmFromFile /etc/hosts" "id:1,deny"';

function wafForm(customDirectives: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set('wafEnabled', 'on');
  form.set('wafCustomDirectives', customDirectives);
  form.set('wafExcludedRuleIds', '[]');
  // Strict unless a test says otherwise: these are the allowlist's tests.
  form.set('wafStrictDirectives', 'on');
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

function stored(custom_directives: string, load_owasp_crs = false): WafSettings {
  return {
    enabled: true,
    mode: 'On',
    load_owasp_crs,
    custom_directives,
    excluded_rule_ids: [],
    strict_directives: true,
  };
}

beforeEach(() => {
  getWafSettingsMock.mockReset();
  getWafSettingsMock.mockResolvedValue(null);
  saveWafSettingsMock.mockClear();
});

describe('updateWafSettingsAction custom directives', () => {
  it('refuses a directive that would be dropped and saves nothing', async () => {
    const result = await updateWafSettingsAction(null, wafForm(DROPPED_RULE));

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/would be dropped and never sent to Caddy/);
    expect(result.message).toContain(DROPPED_RULE);
    expect(result.message).toMatch(/pmFromFile reads files/);
    expect(saveWafSettingsMock).not.toHaveBeenCalled();
  });

  it('refuses an out-of-range body limit directive', async () => {
    const result = await updateWafSettingsAction(null, wafForm('SecRequestBodyLimit 10737418240'));

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/out-of-range body limit/);
    expect(saveWafSettingsMock).not.toHaveBeenCalled();
  });

  it('saves directives that are all kept', async () => {
    const rule = 'SecRule ARGS "@contains evil" "id:2,deny"';
    const result = await updateWafSettingsAction(null, wafForm(rule));

    expect(result.success).toBe(true);
    expect(saveWafSettingsMock.mock.calls[0]?.[0]?.custom_directives).toBe(rule);
  });

  it('checks CRS data-file rules against the submitted CRS setting', async () => {
    const rule = 'SecRule ARGS "@pmf @owasp_crs/unix-shell.data" "id:3,deny"';

    const withoutCrs = await updateWafSettingsAction(null, wafForm(rule));
    expect(withoutCrs.success).toBe(false);
    expect(withoutCrs.message).toMatch(/OWASP CRS is loaded/);

    const withCrs = await updateWafSettingsAction(null, wafForm(rule, { wafLoadOwaspCrs: 'on' }));
    expect(withCrs.success).toBe(true);
  });

  it('does not block saving other fields when the stored directives are unchanged', async () => {
    getWafSettingsMock.mockResolvedValue(stored(DROPPED_RULE));

    const result = await updateWafSettingsAction(
      null,
      wafForm(DROPPED_RULE, { wafLoadOwaspCrs: 'on' }),
    );

    expect(result.success).toBe(true);
    expect(saveWafSettingsMock.mock.calls[0]?.[0]).toMatchObject({
      custom_directives: DROPPED_RULE,
      load_owasp_crs: true,
    });
  });

  it('still refuses a line newly added beside the stored dropped one', async () => {
    getWafSettingsMock.mockResolvedValue(stored(DROPPED_RULE));
    const added = 'Include /etc/passwd';

    const result = await updateWafSettingsAction(null, wafForm(`${DROPPED_RULE}\n${added}`));

    expect(result.success).toBe(false);
    expect(result.message).toContain(added);
    expect(result.message).toMatch(/has 1 line /);
    expect(saveWafSettingsMock).not.toHaveBeenCalled();
  });

  it('refuses turning the CRS off under an unchanged rule that reads a CRS data file', async () => {
    const rule = 'SecRule ARGS "@pmf @owasp_crs/unix-shell.data" "id:4,deny"';
    getWafSettingsMock.mockResolvedValue(stored(rule, true));

    const result = await updateWafSettingsAction(null, wafForm(rule));

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/OWASP CRS is loaded/);
    expect(saveWafSettingsMock).not.toHaveBeenCalled();
  });
});

describe('updateWafSettingsAction id lists', () => {
  it.each(['wafExcludedRuleIds', 'wafPresetIds', 'wafPluginIds'])(
    'refuses a malformed %s with the catalog sentence, saving nothing',
    async (field) => {
      const result = await updateWafSettingsAction(null, wafForm('', { [field]: '[1,' }));

      expect(result).toEqual({
        success: false,
        message: testTranslator()('errors.wafIdListInvalid'),
      });
      expect(saveWafSettingsMock).not.toHaveBeenCalled();
    },
  );
});

describe('updateWafSettingsAction without the strict setting', () => {
  it('saves a risky directive and the setting itself, but not one Coraza lacks', async () => {
    const result = await updateWafSettingsAction(
      null,
      wafForm(DROPPED_RULE, { wafStrictDirectives: '' }),
    );

    expect(result.success).toBe(true);
    const saved = saveWafSettingsMock.mock.calls[0]?.[0];
    expect(saved).toMatchObject({ custom_directives: DROPPED_RULE });
    expect(saved?.strict_directives).toBeUndefined();

    saveWafSettingsMock.mockClear();
    const refused = await updateWafSettingsAction(
      null,
      wafForm('SecBogus On', { wafStrictDirectives: '' }),
    );
    expect(refused.success).toBe(false);
    expect(refused.message).toMatch(/SecBogus is not a directive Coraza knows/);
    expect(saveWafSettingsMock).not.toHaveBeenCalled();
  });

  it('stores the setting when it is switched on', async () => {
    const result = await updateWafSettingsAction(null, wafForm(''));
    expect(result.success).toBe(true);
    expect(saveWafSettingsMock.mock.calls[0]?.[0]).toMatchObject({ strict_directives: true });
  });
});
