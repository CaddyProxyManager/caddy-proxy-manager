/**
 * How a campaign's items are shared out and hinted, without a database: one person's access goes
 * to one reviewer, nobody gets their own, and "unused" counts from creation when never used.
 */
import { describe, expect, it } from 'bun:test';
import { type ItemDraft, assignReviewers, unusedFor } from '@/src/lib/access-reviews/collect';
import { canChange, dueAt, isOverdue } from '@/src/lib/access-reviews/model';

const DAY = 86_400_000;

function draft(
  kind: ItemDraft['kind'],
  userId: number | null,
  groupId: number | null = null,
): ItemDraft {
  return {
    kind,
    userId,
    groupId,
    tokenId: null,
    connectionId: null,
    objectKind: null,
    objectId: null,
    subjectLabel: 'x',
    targetLabel: null,
    current: null,
    hints: [],
    scimManaged: false,
  };
}

describe('assignReviewers', () => {
  it('keeps one person with one reviewer and turns in a circle', () => {
    const items = [draft('role', 1), draft('membership', 1), draft('role', 2), draft('role', 3)];
    expect(assignReviewers(items, [10, 20], 99)).toEqual([10, 10, 20, 10]);
  });

  it('never hands a reviewer their own access', () => {
    const items = [draft('role', 10), draft('token', 20), draft('role', 30)];
    const assigned = assignReviewers(items, [10, 20], 99);
    expect(assigned[0]).toBe(20);
    expect(assigned[1]).toBe(10);
  });

  it('falls back to the author, or to nobody when the author is the subject too', () => {
    expect(assignReviewers([draft('role', 10)], [10], 99)).toEqual([99]);
    expect(assignReviewers([draft('role', 10)], [10], 10)).toEqual([null]);
  });

  it('shares grants out by group, since they belong to no one person', () => {
    const items = [draft('grant', null, 5), draft('grant', null, 5), draft('grant', null, 6)];
    expect(assignReviewers(items, [10, 20], 99)).toEqual([10, 10, 20]);
  });
});

describe('unusedFor', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * DAY).toISOString();

  it('is true past 90 days since the last use', () => {
    expect(unusedFor(daysAgo(91), daysAgo(400), now)).toBe(true);
    expect(unusedFor(daysAgo(89), daysAgo(400), now)).toBe(false);
  });

  it('counts a never-used one from its creation', () => {
    expect(unusedFor(null, daysAgo(120), now)).toBe(true);
    expect(unusedFor(null, daysAgo(10), now)).toBe(false);
    expect(unusedFor(null, null, now)).toBe(false);
  });
});

describe('a campaign date', () => {
  it('is due at the end of its day, UTC', () => {
    expect(new Date(dueAt('2026-10-07')).toISOString()).toBe('2026-10-07T23:59:59.999Z');
    expect(isOverdue('2026-10-07', Date.parse('2026-10-07T23:00:00Z'))).toBe(false);
    expect(isOverdue('2026-10-07', Date.parse('2026-10-08T00:00:00Z'))).toBe(true);
  });

  it('lets only a role or a grant be changed', () => {
    expect(
      ['role', 'membership', 'grant', 'token', 'scimConnection'].filter((kind) =>
        canChange(kind as never),
      ),
    ).toEqual(['role', 'grant']);
  });
});
