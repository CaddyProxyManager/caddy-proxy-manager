import { describe, expect, it } from 'bun:test';
import { diffAuditRecords, parseAuditChanges } from '@/src/lib/audit/changes';
import { MASKED_VALUE } from '@/src/lib/host-review/types';

describe('diffAuditRecords', () => {
  it('lists changed columns only, without bookkeeping', () => {
    expect(
      diffAuditRecords(
        { id: 1, name: 'a', reason: 'x', updatedAt: '1' },
        { id: 1, name: 'b', reason: 'x', updatedAt: '2' },
      ),
    ).toEqual([
      { field: 'name', section: null, before: 'a', after: 'b', leaves: null, masked: false },
    ]);
  });

  it('masks secret-named fields and sealed values at any depth', () => {
    const changes = diffAuditRecords(
      { smtp_password: 'old', dns: { providers: { cf: { api_token: 'enc:v1:aaa', zone: 'z1' } } } },
      { smtp_password: 'new', dns: { providers: { cf: { api_token: 'enc:v1:bbb', zone: 'z2' } } } },
    );
    expect(JSON.stringify(changes)).not.toMatch(/old|new|enc:v1/);
    expect(changes.find((c) => c.field === 'smtp_password')).toMatchObject({
      before: MASKED_VALUE,
      after: MASKED_VALUE,
      masked: true,
    });
    // Ciphertext differs on every save, so a sealed value never reads as a change of its own.
    expect(changes.find((c) => c.field === 'dns')?.leaves).toEqual([
      { path: 'providers.cf.zone', before: 'z1', after: 'z2' },
    ]);
  });

  it('diffs JSON kept in a text column by path', () => {
    const [change] = diffAuditRecords(
      { meta: JSON.stringify({ waf: { mode: 'On' } }) },
      { meta: JSON.stringify({ waf: { mode: 'DetectionOnly' } }) },
    );
    expect(change.leaves).toEqual([{ path: 'waf.mode', before: 'On', after: 'DetectionOnly' }]);
  });

  it('honours omit, and diffs a create against nothing', () => {
    expect(diffAuditRecords(null, { name: 'n', pem: 'x' }, { omit: ['pem'] })).toEqual([
      { field: 'name', section: null, before: null, after: 'n', leaves: null, masked: false },
    ]);
  });
});

describe('parseAuditChanges', () => {
  it('reads changes back from the stored data column', () => {
    const changes = [
      { field: 'name', section: 'general', before: 'a', after: 'b', leaves: null, masked: false },
    ];
    expect(parseAuditChanges(JSON.stringify({ bulk: true, changes }))).toEqual(changes);
  });

  it('is null for events without changes, and drops malformed entries', () => {
    expect(parseAuditChanges(null)).toBeNull();
    expect(parseAuditChanges('not json')).toBeNull();
    expect(parseAuditChanges(JSON.stringify({ changes: [{ nope: 1 }] }))).toBeNull();
    expect(
      parseAuditChanges(
        JSON.stringify({ changes: [{ field: 'x', before: { evil: 1 }, after: 2 }] }),
      ),
    ).toEqual([{ field: 'x', section: null, before: null, after: 2, leaves: null, masked: false }]);
  });
});
