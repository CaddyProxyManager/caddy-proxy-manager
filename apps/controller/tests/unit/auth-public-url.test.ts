/**
 * OAuth redirect URIs follow the Public URL saved in setup or Settings, not BASE_URL alone:
 * Settings tells operators to register a callback built from it.
 */
import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// Imported above the mock factory, which Bun evaluates synchronously while linking.
const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted out of the factory below: a Bun mock factory must be synchronous.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  db: ctx.db,
  client: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  },
}));

// `betterAuth` hands back its options, so getAuth().options is the config createAuth() built.
vi.mock('better-auth', () => ({
  betterAuth: (options: any) => ({ options }),
}));
vi.mock('better-auth/plugins', () => ({
  genericOAuth: () => ({}),
  username: () => ({}),
}));

import { getAuth } from '../../src/lib/auth-server';
import { config } from '../../src/lib/config';
import { baseUrl } from '../../src/lib/settings/registry';
import { clearStoredSetting, saveSettings } from '../../src/lib/settings/resolve';

describe('Better Auth baseURL', () => {
  const fromEnvironment = config.baseUrl.replace(/\/+$/, '');

  it('is BASE_URL while no Public URL is stored', async () => {
    await clearStoredSetting(baseUrl.key);
    expect((await getAuth()).options.baseURL).toBe(fromEnvironment);
  });

  it('follows a Public URL saved at runtime, and stays cached while it is unchanged', async () => {
    await saveSettings({ [baseUrl.key]: 'https://proxy.example.com/' });
    const auth = await getAuth();
    expect(auth.options.baseURL).toBe('https://proxy.example.com');
    expect(await getAuth()).toBe(auth);
  });

  it('returns to BASE_URL once the stored value is cleared', async () => {
    await clearStoredSetting(baseUrl.key);
    expect((await getAuth()).options.baseURL).toBe(fromEnvironment);
  });
});
