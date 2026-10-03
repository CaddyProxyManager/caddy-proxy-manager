/**
 * The settings service: resolution order, validation, and secrets at rest. "Stored, else
 * environment, else default" is what keeps an unmigrated deployment reading what it read before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const schemaModule = await import('@/src/lib/db/schema');

// Hoisted out of the factory below: createTestDb is async, and a Bun mock factory must be
// synchronous - an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

const registry = await import('@/src/lib/settings/registry');
const {
  clearStoredSetting,
  getSetting,
  hasStoredSettings,
  invalidateSettingsCache,
  resolveAllSettings,
  resolveSetting,
  saveSettings,
} = await import('@/src/lib/settings/resolve');

const TOUCHED_ENV = [
  'APP_NAME',
  'AVATAR_GRAVATAR',
  'LOGIN_MAX_ATTEMPTS',
  'CLICKHOUSE_PASSWORD',
  'AUTH_REQUIRE_PASSWORD_CHANGE_ON_LEGACY_HASH',
];

beforeEach(async () => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  await ctx.db.delete(schemaModule.settings);
  invalidateSettingsCache();
});

afterEach(() => {
  for (const name of TOUCHED_ENV) delete process.env[name];
});

describe('resolution order', () => {
  it('falls back to the default when nothing is stored or in the environment', async () => {
    const resolved = await resolveSetting(registry.appName);
    expect(resolved).toEqual({ value: 'Caddy Proxy Manager', source: 'default' });
  });

  it('reads the environment variable when nothing is stored', async () => {
    process.env.APP_NAME = 'Edge Router';
    const resolved = await resolveSetting(registry.appName);
    expect(resolved).toEqual({ value: 'Edge Router', source: 'environment' });
  });

  it('prefers a stored value over the environment', async () => {
    process.env.APP_NAME = 'From The Env';
    await saveSettings({ [registry.appName.key]: 'From The Database' });

    const resolved = await resolveSetting(registry.appName);
    expect(resolved).toEqual({ value: 'From The Database', source: 'stored' });
  });

  it('returns to the environment once the stored value is cleared', async () => {
    process.env.APP_NAME = 'From The Env';
    await saveSettings({ [registry.appName.key]: 'From The Database' });
    await clearStoredSetting(registry.appName.key);

    expect(await resolveSetting(registry.appName)).toEqual({
      value: 'From The Env',
      source: 'environment',
    });
  });

  it('treats an empty variable as unset', async () => {
    process.env.APP_NAME = '   ';
    expect((await resolveSetting(registry.appName)).source).toBe('default');
  });

  it('ignores an environment value that no longer validates', async () => {
    // Out of the setting's range. Refusing to start over a stale .env would be worse than the
    // default, so it is dropped with a warning.
    process.env.LOGIN_MAX_ATTEMPTS = '999999';
    const resolved = await resolveSetting(registry.loginMaxAttempts);
    expect(resolved).toEqual({ value: 5, source: 'default' });
  });
});

describe('typed parsing', () => {
  it('reads the several spellings of a boolean an env file can carry', async () => {
    for (const [raw, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['no', false],
    ] as const) {
      process.env.AVATAR_GRAVATAR = raw;
      invalidateSettingsCache();
      expect(await getSetting(registry.gravatarEnabled)).toBe(expected);
    }
  });

  it('parses a number from the string the environment supplies', async () => {
    process.env.LOGIN_MAX_ATTEMPTS = '25';
    expect(await getSetting(registry.loginMaxAttempts)).toBe(25);
  });

  it('keeps a tri-state setting distinct from false', async () => {
    expect(await getSetting(registry.requirePasswordChangeOnLegacyHash)).toBeNull();

    process.env.AUTH_REQUIRE_PASSWORD_CHANGE_ON_LEGACY_HASH = 'false';
    invalidateSettingsCache();
    expect(await getSetting(registry.requirePasswordChangeOnLegacyHash)).toBe(false);
  });

  it('rejects a value outside the allowed range', async () => {
    await expect(saveSettings({ [registry.loginMaxAttempts.key]: 0 })).rejects.toThrow(
      /between 1 and 1000/,
    );
  });

  it('rejects a URL without a scheme', async () => {
    await expect(saveSettings({ [registry.baseUrl.key]: 'proxy.example.com' })).rejects.toThrow(
      /must start with http/,
    );
  });

  it('rejects a control character rather than letting it reach a Caddy config', async () => {
    await expect(saveSettings({ [registry.appName.key]: 'Proxy\u0007Manager' })).rejects.toThrow(
      /control character/,
    );
  });

  it('refuses a key that is not in the registry', async () => {
    await expect(saveSettings({ 'config:not_a_setting': 'x' })).rejects.toThrow(/Unknown setting/);
  });

  it('writes nothing when any value in the batch is invalid', async () => {
    await expect(
      saveSettings({
        [registry.appName.key]: 'Valid Name',
        [registry.loginMaxAttempts.key]: -1,
      }),
    ).rejects.toThrow();

    expect((await resolveSetting(registry.appName)).source).toBe('default');
  });
});

describe('secrets', () => {
  it('encrypts at rest and returns the plaintext on read', async () => {
    await saveSettings({ [registry.clickhousePassword.key]: 'a-real-password' });

    const [row] = await ctx.db
      .select()
      .from(schemaModule.settings)
      .where(eq(schemaModule.settings.key, registry.clickhousePassword.key));
    expect(row?.value).toBeDefined();
    expect(row?.value).not.toContain('a-real-password');
    expect(row?.value).toContain('enc:v1:');

    expect(await getSetting(registry.clickhousePassword)).toBe('a-real-password');
  });

  it('stores an empty secret as-is rather than encrypting nothing', async () => {
    await saveSettings({ [registry.clickhousePassword.key]: '' });
    expect(await getSetting(registry.clickhousePassword)).toBe('');
  });
});

describe('the ClickHouse connection fields', () => {
  it('reads an emptied field as its default, as Compose and an empty variable do', async () => {
    await saveSettings({
      [registry.clickhouseUrl.key]: '',
      [registry.clickhouseUser.key]: ' ',
      [registry.clickhouseDb.key]: '',
    });
    expect(await getSetting(registry.clickhouseUrl)).toBe('http://clickhouse:8123');
    expect(await getSetting(registry.clickhouseUser)).toBe('cpm');
    expect(await getSetting(registry.clickhouseDb)).toBe('analytics');
  });

  it('reads an empty database name stored before that as the default too', async () => {
    await ctx.db.insert(schemaModule.settings).values({
      key: registry.clickhouseDb.key,
      value: '""',
      updatedAt: new Date().toISOString(),
    });
    expect(await getSetting(registry.clickhouseDb)).toBe('analytics');
  });
});

describe('the whole set', () => {
  it('reports nothing stored before setup has run', async () => {
    expect(await hasStoredSettings()).toBe(false);
    await saveSettings({ [registry.appName.key]: 'Configured' });
    expect(await hasStoredSettings()).toBe(true);
  });

  it('resolves every definition, tagged with where it came from', async () => {
    process.env.APP_NAME = 'From The Env';
    await saveSettings({ [registry.loginMaxAttempts.key]: 9 });

    const all = await resolveAllSettings();
    expect(all.size).toBe(registry.SETTING_DEFINITIONS.length);
    expect(all.get(registry.appName.key)?.source).toBe('environment');
    expect(all.get(registry.loginMaxAttempts.key)).toEqual({ value: 9, source: 'stored' });
    expect(all.get(registry.clickhouseDb.key)?.source).toBe('default');
  });

  it('gives every definition a unique key and environment variable', () => {
    const keys = registry.SETTING_DEFINITIONS.map((d) => d.key);
    const envs = registry.SETTING_DEFINITIONS.map((d) => d.env);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
    // The prefix is what keeps these from colliding with the JSON blobs already in the table.
    expect(keys.every((key) => key.startsWith('config:'))).toBe(true);
  });
});

describe('group gates', () => {
  it('marks at most one gate per group', () => {
    // The setup form renders the gate as the group's switch and everything else behind it, so a
    // second one in the same group would silently not be drawn.
    const perGroup = new Map<string, number>();
    for (const definition of registry.SETTING_DEFINITIONS) {
      if (!definition.gate) continue;
      perGroup.set(definition.group, (perGroup.get(definition.group) ?? 0) + 1);
    }
    expect([...perGroup.values()].every((count) => count === 1)).toBe(true);
    expect([...perGroup.keys()].sort()).toEqual(['analytics', 'email', 'geoip']);
  });

  it('leaves a gate tri-state so an upgrade infers rather than defaults to off', () => {
    // Every deployment upgrading into this release has nothing stored. If the default were `false`
    // rather than `null`, starting the app would read as someone having turned analytics off.
    for (const definition of registry.SETTING_DEFINITIONS) {
      if (definition.gate) expect(definition.default).toBeNull();
    }
  });

  it('accepts the "on" a switch posts, and the empty string it posts when off', () => {
    // The setup form writes a definite boolean for a gate, and the Switch wrapper submits "on" or
    // "". Only the first has to survive parse - the action turns anything else into false itself.
    expect(registry.analyticsEnabled.parse('on')).toBe(true);
    expect(registry.analyticsEnabled.parse('')).toBeNull();
    expect(registry.geoipEnabled.parse('on')).toBe(true);
  });

  it('stores an explicit false distinctly from an unset gate', async () => {
    // The difference the whole tri-state exists for: "off, because I said so" has to outrank the
    // inference, or turning analytics off in setup would be undone by the password still being set.
    await saveSettings({ [registry.analyticsEnabled.key]: false });
    await expect(getSetting(registry.analyticsEnabled)).resolves.toBe(false);

    await clearStoredSetting(registry.analyticsEnabled.key);
    await expect(getSetting(registry.analyticsEnabled)).resolves.toBeNull();
  });
});
