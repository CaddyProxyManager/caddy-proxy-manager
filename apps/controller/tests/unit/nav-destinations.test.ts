/**
 * Rail, tab bar, drawer and More page all read one list. The drawer is saved per user, so a choice
 * can outlive the role that made it.
 */
import { describe, expect, it } from 'bun:test';
import {
  DESTINATIONS,
  MORE_DRAWER_SLOTS,
  RAIL_GROUPS,
  isDestinationId,
  moreDestinations,
  resolveDrawer,
  visibleDestinations,
} from '@/src/lib/nav/destinations';

const ids = (list: { id: string }[]) => list.map((d) => d.id);

describe('visibleDestinations', () => {
  it('shows an admin every page', () => {
    expect(visibleDestinations('admin')).toHaveLength(DESTINATIONS.length);
  });

  it('shows an operator the pages scoped to their grants, plus Overview and Profile', () => {
    expect(ids(visibleDestinations('operator'))).toEqual([
      'overview',
      'proxy-hosts',
      'l4-proxy-hosts',
      'agents',
      'profile',
    ]);
  });

  it('shows anyone else only Overview and Profile', () => {
    expect(ids(visibleDestinations('user'))).toEqual(['overview', 'profile']);
    expect(ids(visibleDestinations(undefined))).toEqual(['overview', 'profile']);
  });
});

describe('moreDestinations', () => {
  it('holds the twelve pages the tab bar cannot name, for an admin', () => {
    const more = ids(moreDestinations('admin'));
    expect(more).toHaveLength(12);
    expect(more).toContain('security');
    for (const tab of ['overview', 'proxy-hosts', 'l4-proxy-hosts', 'agents', 'analytics']) {
      expect(more).not.toContain(tab);
    }
  });

  it('leaves an operator only Profile', () => {
    expect(ids(moreDestinations('operator'))).toEqual(['profile']);
  });
});

describe('resolveDrawer', () => {
  it('defaults to the first eight in canonical order until a choice is saved', () => {
    const drawer = resolveDrawer(null, 'admin');
    expect(drawer).toHaveLength(MORE_DRAWER_SLOTS);
    expect(ids(drawer)).toEqual(ids(moreDestinations('admin')).slice(0, MORE_DRAWER_SLOTS));
  });

  it('keeps a saved choice in the order it was chosen', () => {
    expect(ids(resolveDrawer(['waf', 'users', 'settings'], 'admin'))).toEqual([
      'waf',
      'users',
      'settings',
    ]);
  });

  it('drops pages the role can no longer open', () => {
    // A demoted admin's saved drawer still names Settings.
    expect(ids(resolveDrawer(['settings', 'profile', 'waf'], 'operator'))).toEqual(['profile']);
  });

  it('ignores pages that are not behind More', () => {
    expect(ids(resolveDrawer(['overview', 'waf', 'analytics'], 'admin'))).toEqual(['waf']);
  });

  it('never holds more than the slot count', () => {
    const everything = ids(moreDestinations('admin')) as Parameters<typeof resolveDrawer>[0];
    expect(resolveDrawer(everything, 'admin')).toHaveLength(MORE_DRAWER_SLOTS);
  });

  it('treats an empty saved choice as a real, empty drawer rather than the defaults', () => {
    // Null means "never chose"; an empty list means "chose nothing", and only All pages remains.
    expect(resolveDrawer([], 'admin')).toEqual([]);
  });
});

describe('rail groups', () => {
  it('titles every rail page but Overview, which sits above the sections', () => {
    const ungrouped = ids(DESTINATIONS.filter((d) => d.id !== 'profile' && !d.railGroup));
    expect(ungrouped).toEqual(['overview']);
  });

  it('only uses the groups the rail renders', () => {
    for (const d of DESTINATIONS) {
      if (d.railGroup) expect(RAIL_GROUPS, d.id).toContain(d.railGroup);
    }
  });
});

describe('isDestinationId', () => {
  it('accepts a known page and rejects anything else', () => {
    expect(isDestinationId('waf')).toBe(true);
    expect(isDestinationId('nope')).toBe(false);
    expect(isDestinationId(42)).toBe(false);
  });
});
