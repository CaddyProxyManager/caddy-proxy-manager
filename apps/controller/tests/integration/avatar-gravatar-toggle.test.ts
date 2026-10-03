/** AVATAR_GRAVATAR beats the Settings toggle, which defaults on. */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { reloadConfig } from '@/tests/helpers/config';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Out of the factory: an async Bun mock factory never resolves. Created once, so a re-run of the
// factory keeps the setting the env-override cases saved a moment earlier.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { settings } from '../../src/lib/db/schema';
// Static so the db mock has run before the first beforeEach.
import '../../src/lib/settings';

/** config snapshots process.env on first load, so it is re-read per env stub. */
async function load(env: Record<string, string | undefined> = {}) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  await reloadConfig();
  return import('../../src/lib/settings');
}

beforeEach(async () => {
  await ctx.db.delete(settings);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isGravatarEnabled', () => {
  it('defaults to enabled on an untouched instance', async () => {
    const { isGravatarEnabled } = await load();
    expect(await isGravatarEnabled()).toBe(true);
  });

  it('follows the stored toggle when the environment stays out of it', async () => {
    const { saveAvatarSettings, isGravatarEnabled } = await load();

    await saveAvatarSettings({ gravatarEnabled: false });
    expect(await isGravatarEnabled()).toBe(false);

    await saveAvatarSettings({ gravatarEnabled: true });
    expect(await isGravatarEnabled()).toBe(true);
  });

  it('lets AVATAR_GRAVATAR=false override a toggle left enabled', async () => {
    const { saveAvatarSettings } = await load();
    await saveAvatarSettings({ gravatarEnabled: true });

    const { isGravatarEnabled } = await load({ AVATAR_GRAVATAR: 'false' });
    expect(await isGravatarEnabled()).toBe(false);
  });

  it('lets AVATAR_GRAVATAR=true override a toggle left disabled', async () => {
    const { saveAvatarSettings } = await load();
    await saveAvatarSettings({ gravatarEnabled: false });

    const { isGravatarEnabled } = await load({ AVATAR_GRAVATAR: 'true' });
    expect(await isGravatarEnabled()).toBe(true);
  });

  it('accepts the usual spellings of off', async () => {
    for (const value of ['false', 'FALSE', '0', 'no', ' False ']) {
      const { isGravatarEnabled } = await load({ AVATAR_GRAVATAR: value });
      expect(await isGravatarEnabled(), `AVATAR_GRAVATAR=${value}`).toBe(false);
    }
  });

  it('treats an empty variable as unset, leaving the toggle in charge', async () => {
    const { saveAvatarSettings } = await load();
    await saveAvatarSettings({ gravatarEnabled: false });

    const { isGravatarEnabled } = await load({ AVATAR_GRAVATAR: '' });
    expect(await isGravatarEnabled()).toBe(false);
  });
});

describe('resolveAvatar honours the decision', () => {
  const user = { name: 'Ada', email: 'ada@example.com', avatarUrl: null };

  it('offers a Gravatar when enabled', async () => {
    const { resolveAvatar } = await import('../../src/lib/avatar');
    expect(resolveAvatar(user, 72, { gravatar: true }).gravatarUrl).toContain('gravatar.com');
  });

  it('produces no Gravatar URL at all when disabled', async () => {
    const { resolveAvatar } = await import('../../src/lib/avatar');
    const resolved = resolveAvatar(user, 72, { gravatar: false });
    expect(resolved.gravatarUrl).toBeNull();
    expect(resolved.initial).toBe('A');
  });

  it('still shows a user their own icon when Gravatar is off', async () => {
    const { resolveAvatar } = await import('../../src/lib/avatar');
    const resolved = resolveAvatar({ ...user, avatarUrl: 'data:image/png;base64,AAAA' }, 72, {
      gravatar: false,
    });
    expect(resolved.imageUrl).toBe('data:image/png;base64,AAAA');
    expect(resolved.gravatarUrl).toBeNull();
  });
});
