/**
 * Acknowledged Needs attention items: hidden from the overview by id and code, audited, and
 * forgotten once the condition clears so a recurrence shows again.
 */
import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';
import type { AttentionItem, AttentionList } from '../../../src/lib/attention/types';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../../helpers/db');

ctx.db = await createTestDb();

vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

const schema = await import('../../../src/lib/db/schema');
const acks = await import('../../../src/lib/attention/acknowledged');
const audit = vi.mocked((await import('../../../src/lib/audit')).logAuditEvent);

function item(id: string, code: AttentionItem['code']): AttentionItem {
  return {
    id,
    provider: 'certificates',
    code,
    severity: 'warning',
    values: {},
    href: null,
    at: null,
    scope: {},
  };
}

const listOf = (...items: AttentionItem[]): AttentionList => ({ items, skipped: [], truncated: 0 });

beforeEach(async () => {
  audit.mockClear();
  await ctx.db.delete(schema.settings);
});

describe('acknowledging an item', () => {
  it('hides it from the list, audits it, and logs it', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await acks.acknowledgeAttention({ id: 'certificate:12', code: 'certificateExpiring' }, 7),
      ).toBe(true);
      expect(log.mock.calls.some(([line]) => String(line).includes('certificate:12'))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, entityType: 'attention' }),
    );

    const state = await acks.getAcknowledgements();
    const shown = acks.withoutAcknowledged(
      listOf(item('certificate:12', 'certificateExpiring'), item('geoip', 'geoipFailing')),
      state,
    );
    expect(shown.list.items.map((i) => i.id)).toEqual(['geoip']);
    expect(shown.acknowledged).toBe(1);
  });

  it('shows it again once it gets worse', async () => {
    spyOn(console, 'log').mockImplementationOnce(() => {});
    await acks.acknowledgeAttention({ id: 'certificate:12', code: 'certificateExpiring' }, 7);
    const shown = acks.withoutAcknowledged(
      listOf(item('certificate:12', 'certificateExpired')),
      await acks.getAcknowledgements(),
    );
    expect(shown.list.items).toHaveLength(1);
  });

  it('refuses a code that is not one', async () => {
    expect(await acks.acknowledgeAttention({ id: 'x', code: 'notACode' }, 7)).toBe(false);
    expect(await acks.getAcknowledgements()).toEqual({});
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('pruneAcknowledgements', () => {
  beforeEach(async () => {
    spyOn(console, 'log').mockImplementation(() => {});
    await acks.acknowledgeAttention({ id: 'certificate:12', code: 'certificateExpiring' }, 7);
    await acks.acknowledgeAttention({ id: 'geoip', code: 'geoipFailing' }, 7);
  });

  it('forgets what has cleared and keeps what is still open', async () => {
    await acks.pruneAcknowledgements(listOf(item('geoip', 'geoipFailing')));
    expect(Object.keys(await acks.getAcknowledgements())).toEqual(['geoip']);
  });

  it('keeps everything when a provider was skipped, since its items are missing, not cleared', async () => {
    await acks.pruneAcknowledgements({ items: [], skipped: ['certificates'], truncated: 0 });
    expect(Object.keys(await acks.getAcknowledgements()).sort()).toEqual([
      'certificate:12',
      'geoip',
    ]);
  });

  it('keeps everything when the list was truncated', async () => {
    await acks.pruneAcknowledgements({ items: [], skipped: [], truncated: 3 });
    expect(Object.keys(await acks.getAcknowledgements())).toHaveLength(2);
  });
});

describe('normalizeAcknowledgements', () => {
  it('drops entries without a known code', () => {
    expect(
      acks.normalizeAcknowledgements({
        a: { code: 'geoipFailing', at: 'x', by: 1 },
        b: { code: 'nope' },
        c: 5,
      }),
    ).toEqual({ a: { code: 'geoipFailing', at: 'x', by: 1 } });
    expect(acks.normalizeAcknowledgements('junk')).toEqual({});
  });
});
