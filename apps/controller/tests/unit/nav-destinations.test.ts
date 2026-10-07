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
import { capabilitiesOf } from '@/tests/helpers/access';

const ids = (list: { id: string }[]) => list.map((d) => d.id);

describe('visibleDestinations', () => {
  it('shows an admin every page', () => {
    expect(visibleDestinations(capabilitiesOf('admin'))).toHaveLength(DESTINATIONS.length);
  });

  it('shows an operator the pages scoped to their grants, plus Overview and Profile', () => {
    expect(ids(visibleDestinations(capabilitiesOf('operator')))).toEqual([
      'overview',
      'proxy-hosts',
      'l4-proxy-hosts',
      'agents',
      'approvals',
      'profile',
    ]);
  });

  it('shows a role a page for each area it holds, held outright or not', () => {
    expect(ids(visibleDestinations({ 'audit:read': 'all', 'hosts:read': 'granted' }))).toEqual([
      'overview',
      'proxy-hosts',
      'l4-proxy-hosts',
      'audit-log',
      'approvals',
      'profile',
    ]);
  });

  it('shows anyone else only Overview, Approvals and Profile', () => {
    // Approvals is anyone's: a policy can name an approver by group, whatever their role.
    expect(ids(visibleDestinations(capabilitiesOf('user')))).toEqual([
      'overview',
      'approvals',
      'profile',
    ]);
    expect(ids(visibleDestinations({}))).toEqual(['overview', 'approvals', 'profile']);
  });
});

describe('moreDestinations', () => {
  it('holds the thirteen pages the tab bar cannot name, for an admin', () => {
    const more = ids(moreDestinations(capabilitiesOf('admin')));
    expect(more).toHaveLength(13);
    expect(more).toContain('security');
    for (const tab of ['overview', 'proxy-hosts', 'l4-proxy-hosts', 'agents', 'analytics']) {
      expect(more).not.toContain(tab);
    }
  });

  it('leaves an operator only Approvals and Profile', () => {
    expect(ids(moreDestinations(capabilitiesOf('operator')))).toEqual(['approvals', 'profile']);
  });
});

describe('resolveDrawer', () => {
  it('defaults to the first eight in canonical order until a choice is saved', () => {
    const drawer = resolveDrawer(null, capabilitiesOf('admin'));
    expect(drawer).toHaveLength(MORE_DRAWER_SLOTS);
    expect(ids(drawer)).toEqual(
      ids(moreDestinations(capabilitiesOf('admin'))).slice(0, MORE_DRAWER_SLOTS),
    );
  });

  it('keeps a saved choice in the order it was chosen', () => {
    expect(ids(resolveDrawer(['waf', 'users', 'settings'], capabilitiesOf('admin')))).toEqual([
      'waf',
      'users',
      'settings',
    ]);
  });

  it('drops pages the role can no longer open', () => {
    // A demoted admin's saved drawer still names Settings.
    expect(ids(resolveDrawer(['settings', 'profile', 'waf'], capabilitiesOf('operator')))).toEqual([
      'profile',
    ]);
  });

  it('ignores pages that are not behind More', () => {
    expect(ids(resolveDrawer(['overview', 'waf', 'analytics'], capabilitiesOf('admin')))).toEqual([
      'waf',
    ]);
  });

  it('never holds more than the slot count', () => {
    const everything = ids(moreDestinations(capabilitiesOf('admin'))) as Parameters<
      typeof resolveDrawer
    >[0];
    expect(resolveDrawer(everything, capabilitiesOf('admin'))).toHaveLength(MORE_DRAWER_SLOTS);
  });

  it('treats an empty saved choice as a real, empty drawer rather than the defaults', () => {
    // Null means "never chose"; an empty list means "chose nothing", and only All pages remains.
    expect(resolveDrawer([], capabilitiesOf('admin'))).toEqual([]);
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
