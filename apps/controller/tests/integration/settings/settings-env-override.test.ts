/**
 * SETTINGS_ENV_OVERRIDE lets a variable beat a stored value: the way out of a saved setting that
 * locks everyone out of Settings. Opt-in per variable, because Compose passes BASE_URL and
 * AUTH_DISABLE_LOCAL_USERS on every deployment, so "env always wins" would freeze them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

// Hoisted out of the factory: createTestDb is async, and a Bun mock factory must be synchronous.
ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const registry = await import('../../../src/lib/settings/registry');
const { clearStoredSetting, invalidateSettingsCache, resolveSetting, saveSettings } = await import(
  '../../../src/lib/settings/resolve'
);

const ENV_KEYS = [
  'AUTH_DISABLE_LOCAL_USERS',
  'BASE_URL',
  'APP_NAME',
  'SETTINGS_ENV_OVERRIDE',
] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  invalidateSettingsCache();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const definition of [registry.disableLocalUsers, registry.baseUrl, registry.appName]) {
    await clearStoredSetting(definition.key).catch(() => {});
  }
  invalidateSettingsCache();
});

describe('a variable named in SETTINGS_ENV_OVERRIDE', () => {
  it('takes the variable over a stored value, and says where it came from', async () => {
    await saveSettings({ [registry.disableLocalUsers.key]: true });
    process.env.AUTH_DISABLE_LOCAL_USERS = 'false';
    process.env.SETTINGS_ENV_OVERRIDE = 'AUTH_DISABLE_LOCAL_USERS';
    invalidateSettingsCache();

    const resolved = await resolveSetting(registry.disableLocalUsers);
    expect(resolved.value).toBe(false);
    expect(resolved.source).toBe('environment');
  });

  it('falls back to the stored value once the override is removed', async () => {
    await saveSettings({ [registry.disableLocalUsers.key]: true });
    process.env.AUTH_DISABLE_LOCAL_USERS = 'false';
    process.env.SETTINGS_ENV_OVERRIDE = 'AUTH_DISABLE_LOCAL_USERS';
    invalidateSettingsCache();
    expect((await resolveSetting(registry.disableLocalUsers)).value).toBe(false);

    delete process.env.SETTINGS_ENV_OVERRIDE;
    invalidateSettingsCache();

    const resolved = await resolveSetting(registry.disableLocalUsers);
    expect(resolved.value).toBe(true);
    expect(resolved.source).toBe('stored');
  });

  it('recovers a public URL that was saved wrong', async () => {
    await saveSettings({ [registry.baseUrl.key]: 'https://wrong.example.test' });
    process.env.BASE_URL = 'https://cpm.example.com';
    process.env.SETTINGS_ENV_OVERRIDE = 'BASE_URL, AUTH_DISABLE_LOCAL_USERS';
    invalidateSettingsCache();

    expect((await resolveSetting(registry.baseUrl)).value).toBe('https://cpm.example.com');
  });
});

describe('a variable it does not name', () => {
  it('still loses to a stored value, even beside one it does name', async () => {
    await saveSettings({ [registry.appName.key]: 'Stored Name' });
    process.env.APP_NAME = 'Environment Name';
    process.env.SETTINGS_ENV_OVERRIDE = 'BASE_URL';
    invalidateSettingsCache();

    const resolved = await resolveSetting(registry.appName);
    expect(resolved.value).toBe('Stored Name');
    expect(resolved.source).toBe('stored');
  });
});
