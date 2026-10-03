/**
 * The real AsyncLocalStorage seam, not its wrappers: if the scope stops being consulted, an edit
 * silently becomes a live write.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// A Bun mock factory must be synchronous; an async one never resolves and hangs the file.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import { settings, settingsStaged, users } from '../../src/lib/db/schema';
import { eq } from 'drizzle-orm';

const { getSetting, setSetting } = await import('../../src/lib/settings');
const { withCapturedWrites, withStagedReads } = await import(
  '../../src/lib/settings/staging-context'
);
const { listStagedSettings, stageWrites, stagedOverlay, discardAllStaged, getStagedSetting } =
  await import('../../src/lib/settings/staging');

let userId: number;

beforeEach(async () => {
  await ctx.db.delete(settingsStaged);
  await ctx.db.delete(settings);
  await ctx.db.delete(users);

  const [row] = await ctx.db
    .insert(users)
    .values({
      email: 'ops@example.com',
      name: 'Ops',
      role: 'admin',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returning({ id: users.id });
  userId = row?.id as number;
});

describe('capture scope', () => {
  it('diverts a write away from the settings table', async () => {
    const { writes } = await withCapturedWrites(new Map(), async () => {
      await setSetting('general', { defaultDomain: 'staged.example.com' });
    });

    expect(writes.get('general')).toBe(JSON.stringify({ defaultDomain: 'staged.example.com' }));
    expect(await ctx.db.select().from(settings)).toHaveLength(0);
  });

  it('leaves writes alone outside a capture scope', async () => {
    await setSetting('general', { defaultDomain: 'live.example.com' });

    const stored = await getSetting<{ defaultDomain: string }>('general');
    expect(stored?.defaultDomain).toBe('live.example.com');
  });

  it('lets an action read back what it wrote a moment earlier', async () => {
    // Actions read-modify-write a blob; a second write must see the first.
    const { writes } = await withCapturedWrites(new Map(), async () => {
      await setSetting('general', { defaultDomain: 'first.example.com', acmeEmail: 'a@b.c' });
    });

    const overlay = new Map(writes);
    const seen = await withStagedReads(overlay, () =>
      getSetting<{ defaultDomain: string; acmeEmail: string }>('general'),
    );
    expect(seen?.defaultDomain).toBe('first.example.com');
    expect(seen?.acmeEmail).toBe('a@b.c');
  });
});

describe('read overlay', () => {
  it('prefers a staged value over the stored one', async () => {
    await setSetting('general', { defaultDomain: 'stored.example.com' });

    const overlay = new Map([['general', JSON.stringify({ defaultDomain: 'staged.example.com' })]]);
    const seen = await withStagedReads(overlay, () =>
      getSetting<{ defaultDomain: string }>('general'),
    );

    expect(seen?.defaultDomain).toBe('staged.example.com');
    // And the stored value is genuinely unchanged, not merely shadowed once.
    expect((await getSetting<{ defaultDomain: string }>('general'))?.defaultDomain).toBe(
      'stored.example.com',
    );
  });

  it('falls through to the table for keys nobody staged', async () => {
    await setSetting('acme', { caUrl: 'https://acme.example.com' });

    const overlay = new Map([['general', JSON.stringify({ defaultDomain: 'x' })]]);
    const seen = await withStagedReads(overlay, () => getSetting<{ caUrl: string }>('acme'));

    expect(seen?.caUrl).toBe('https://acme.example.com');
  });

  it('does not leak outside its own scope', async () => {
    await setSetting('general', { defaultDomain: 'stored.example.com' });
    const overlay = new Map([['general', JSON.stringify({ defaultDomain: 'staged.example.com' })]]);

    await withStagedReads(overlay, async () => getSetting('general'));

    const after = await getSetting<{ defaultDomain: string }>('general');
    expect(after?.defaultDomain).toBe('stored.example.com');
  });
});

describe('stageWrites', () => {
  it('records a change and reads it back through the overlay', async () => {
    await stageWrites(
      userId,
      new Map([['general', JSON.stringify({ defaultDomain: 'staged.example.com' })]]),
    );

    expect(await listStagedSettings(userId)).toHaveLength(1);
    const seen = await getStagedSetting<{ defaultDomain: string }>(userId, 'general');
    expect(seen?.defaultDomain).toBe('staged.example.com');
  });

  it('does not stage a write that matches what is stored', async () => {
    await setSetting('general', { defaultDomain: 'same.example.com' });

    await stageWrites(
      userId,
      new Map([['general', JSON.stringify({ defaultDomain: 'same.example.com' })]]),
    );

    // Or the review sheet shows a change from a value to itself.
    expect(await listStagedSettings(userId)).toHaveLength(0);
  });

  it('unstages a key when the operator sets it back to the stored value', async () => {
    await setSetting('general', { defaultDomain: 'stored.example.com' });
    await stageWrites(
      userId,
      new Map([['general', JSON.stringify({ defaultDomain: 'changed.example.com' })]]),
    );
    expect(await listStagedSettings(userId)).toHaveLength(1);

    await stageWrites(
      userId,
      new Map([['general', JSON.stringify({ defaultDomain: 'stored.example.com' })]]),
    );
    expect(await listStagedSettings(userId)).toHaveLength(0);
  });

  it('replaces an earlier staged value for the same key rather than adding a row', async () => {
    await stageWrites(userId, new Map([['general', JSON.stringify({ defaultDomain: 'one' })]]));
    await stageWrites(userId, new Map([['general', JSON.stringify({ defaultDomain: 'two' })]]));

    const staged = await listStagedSettings(userId);
    expect(staged).toHaveLength(1);
    expect(await getStagedSetting<{ defaultDomain: string }>(userId, 'general')).toEqual({
      defaultDomain: 'two',
    });
  });

  it('keeps one operator change set out of another', async () => {
    const [other] = await ctx.db
      .insert(users)
      .values({
        email: 'other@example.com',
        name: 'Other',
        role: 'admin',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning({ id: users.id });
    const otherId = other?.id as number;

    await stageWrites(userId, new Map([['general', JSON.stringify({ defaultDomain: 'mine' })]]));
    await stageWrites(otherId, new Map([['acme', JSON.stringify({ caUrl: 'https://theirs' })]]));

    expect([...(await stagedOverlay(userId)).keys()]).toEqual(['general']);
    expect([...(await stagedOverlay(otherId)).keys()]).toEqual(['acme']);
  });

  it('discards a whole change set without touching another operator', async () => {
    const [other] = await ctx.db
      .insert(users)
      .values({
        email: 'other2@example.com',
        name: 'Other',
        role: 'admin',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning({ id: users.id });
    const otherId = other?.id as number;

    await stageWrites(userId, new Map([['general', JSON.stringify({ defaultDomain: 'mine' })]]));
    await stageWrites(otherId, new Map([['general', JSON.stringify({ defaultDomain: 'theirs' })]]));

    await discardAllStaged(userId);

    expect(await listStagedSettings(userId)).toHaveLength(0);
    expect(await listStagedSettings(otherId)).toHaveLength(1);
  });

  it('cascades a change set away with its operator', async () => {
    await stageWrites(userId, new Map([['general', JSON.stringify({ defaultDomain: 'mine' })]]));

    await ctx.db.delete(users).where(eq(users.id, userId));

    expect(await ctx.db.select().from(settingsStaged)).toHaveLength(0);
  });
});
