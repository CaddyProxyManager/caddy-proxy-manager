/**
 * History names each apply from its stored keys, in the reader's language; `summary` stays as
 * written, and a row with unreadable keys still shows something.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// bun runs a vi.mock factory synchronously, so its helpers are imported above it.
const { createTestDb } = await import('../helpers/db');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/caddy', () => ({
  applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }),
  buildCaddyDocument: vi.fn().mockResolvedValue({}),
}));

import { applyStagedSettings, recentRevisions } from '../../src/lib/settings/apply';
import { listStagedSettings, stageWrites } from '../../src/lib/settings/staging';
import {
  compareRevisions,
  previousRevisionId,
  revisionExists,
  stageRevisionRestore,
} from '../../src/lib/settings/revisions';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { DomainError } from '../../src/lib/domain-error';
import * as schema from '../../src/lib/db/schema';

beforeEach(async () => {
  await ctx.db.delete(schema.settingsRevisions);
});

async function insertRevision(summary: string, keys: string) {
  await ctx.db.insert(schema.settingsRevisions).values({
    appliedBy: null,
    appliedByName: 'Admin',
    summary,
    keys,
    outcome: 'applied',
    error: null,
    appliedAt: new Date().toISOString(),
  });
}

describe('recentRevisions', () => {
  it('returns the committed keys with the summary left as stored', async () => {
    await insertRevision('waf, geoblock', JSON.stringify(['waf', 'geoblock']));
    const [revision] = await recentRevisions(1);
    expect(revision.summary).toBe('waf, geoblock');
    expect(revision.keys).toEqual(['waf', 'geoblock']);
  });

  it('stores the English fallback for a non-Error failure, and hands back a code to render', async () => {
    await ctx.db.delete(schema.users).catch(() => {});
    await ctx.db.insert(schema.users).values({
      id: 1,
      email: 'test@example.com',
      name: 'Test User',
      role: 'admin',
      provider: 'credentials',
      subject: 'test',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await stageWrites(1, new Map([['general', JSON.stringify({ primaryDomain: 'example.test' })]]));
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce('not an Error');

    const outcome = await applyStagedSettings(1, 'Test User');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('Failed to apply Caddy configuration');
    expect(outcome.cause).toBeInstanceOf(DomainError);
    expect((outcome.cause as DomainError).code).toBe('applyCaddyConfigFailed');

    const [revision] = await recentRevisions(1);
    expect(revision.outcome).toBe('failed');
    expect(revision.error).toBe('Failed to apply Caddy configuration');
  });

  it('yields no keys for an unreadable column, so the sheet shows the summary instead', async () => {
    await insertRevision('waf', 'not json');
    await insertRevision('geoblock', JSON.stringify({ not: 'a list' }));
    const revisions = await recentRevisions(2);
    expect(revisions.map((revision) => revision.keys)).toEqual([[], []]);
  });
});

describe('revision version control', () => {
  beforeEach(async () => {
    await ctx.db.delete(schema.settingsStaged);
    await ctx.db.delete(schema.settings);
    await ctx.db.delete(schema.users).catch(() => {});
    await ctx.db.insert(schema.users).values({
      id: 1,
      email: 'test@example.com',
      name: 'Test User',
      role: 'admin',
      provider: 'credentials',
      subject: 'test',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  async function apply(writes: Record<string, unknown>): Promise<number> {
    await stageWrites(
      1,
      new Map(Object.entries(writes).map(([key, value]) => [key, JSON.stringify(value)])),
    );
    const outcome = await applyStagedSettings(1, 'Test User');
    return outcome.revision;
  }

  it('stages a registry setting: read back in scope, live only once applied', async () => {
    const { accentColor } = await import('../../src/lib/settings/registry');
    const { getSetting: getRegistrySetting, invalidateSettingsCache } = await import(
      '../../src/lib/settings/resolve'
    );
    const { stagedOverlay } = await import('../../src/lib/settings/staging');
    const { withStagedReads } = await import('../../src/lib/settings/staging-context');
    invalidateSettingsCache();
    // Warm the cache, so a missed invalidation on apply would leave pink behind.
    expect(await getRegistrySetting(accentColor)).toBe('pink');

    await stageWrites(1, new Map([[accentColor.key, JSON.stringify('teal')]]));
    expect(await getRegistrySetting(accentColor)).toBe('pink');
    const overlay = await stagedOverlay(1);
    expect(await withStagedReads(overlay, () => getRegistrySetting(accentColor))).toBe('teal');

    await applyStagedSettings(1, 'Test User');
    expect(await getRegistrySetting(accentColor)).toBe('teal');
  });

  it('reads a staged clear of a registry setting as cleared, not as the stored value', async () => {
    const { accentColor } = await import('../../src/lib/settings/registry');
    const { getSetting: getRegistrySetting, invalidateSettingsCache } = await import(
      '../../src/lib/settings/resolve'
    );
    const { withStagedReads } = await import('../../src/lib/settings/staging-context');
    await apply({ [accentColor.key]: 'teal' });
    invalidateSettingsCache();
    const overlay = new Map([[accentColor.key, 'null']]);
    expect(await withStagedReads(overlay, () => getRegistrySetting(accentColor))).toBe('pink');
    expect(await getRegistrySetting(accentColor)).toBe('teal');
  });

  it('records each key before and after, so the revision is comparable', async () => {
    const first = await apply({ general: { defaultDomain: 'a.test' } });
    const second = await apply({ general: { defaultDomain: 'b.test' } });

    const [latest] = await recentRevisions(1);
    expect(latest.recorded).toBe(true);

    const comparison = await compareRevisions(first, second);
    expect(comparison.keys?.map((entry) => entry.key)).toEqual(['general']);
    const lines = comparison.keys?.[0]?.diff.lines ?? [];
    expect(lines.some((line) => line.kind === 'removed' && line.text.includes('a.test'))).toBe(
      true,
    );
    expect(lines.some((line) => line.kind === 'added' && line.text.includes('b.test'))).toBe(true);

    const reversed = await compareRevisions(second, first);
    const back = reversed.keys?.[0]?.diff.lines ?? [];
    expect(back.some((line) => line.kind === 'added' && line.text.includes('a.test'))).toBe(true);
  });

  it('masks credentials inside a compared blob', async () => {
    const first = await apply({ cloudflare: { apiToken: 'one' } });
    const second = await apply({ cloudflare: { apiToken: 'two' } });
    const comparison = await compareRevisions(first, second);
    const text = (comparison.keys?.[0]?.diff.lines ?? []).map((line) => line.text).join('\n');
    expect(text).not.toContain('one');
    expect(text).not.toContain('two');
  });

  it('stages the values an earlier revision had, including clearing a key it did not have', async () => {
    const first = await apply({ general: { defaultDomain: 'a.test' } });
    await apply({ general: { defaultDomain: 'b.test' }, waf: { enabled: true } });

    const { staged } = await stageRevisionRestore(1, first);
    expect(staged).toBe(2);
    const entries = new Map((await listStagedSettings(1)).map((entry) => [entry.key, entry.value]));
    expect(JSON.parse(entries.get('general') ?? 'null')).toEqual({ defaultDomain: 'a.test' });
    expect(entries.get('waf')).toBe('null');
  });

  it('refuses to restore across a revision without recorded values', async () => {
    const first = await apply({ general: { defaultDomain: 'a.test' } });
    await insertRevision('waf', JSON.stringify(['waf']));
    await expect(stageRevisionRestore(1, first)).rejects.toMatchObject({
      code: 'revisionNotRecorded',
    });
    expect((await compareRevisions(0, first + 1)).keys).toBeNull();
  });

  it('finds the revision before one across gaps in the ids, and 0 before the first', async () => {
    const first = await apply({ general: { defaultDomain: 'a.test' } });
    await ctx.db.insert(schema.settingsRevisions).values({
      id: first + 5,
      appliedBy: null,
      appliedByName: 'Admin',
      summary: 'waf',
      keys: JSON.stringify(['waf']),
      outcome: 'applied',
      error: null,
      appliedAt: new Date().toISOString(),
    });
    expect(await previousRevisionId(first + 5)).toBe(first);
    expect(await previousRevisionId(first)).toBe(0);
    expect(await revisionExists(first + 5)).toBe(true);
    expect(await revisionExists(first + 1)).toBe(false);
  });

  it('refuses a revision that does not exist', async () => {
    await expect(stageRevisionRestore(1, 99)).rejects.toMatchObject({ code: 'revisionNotFound' });
  });
});
