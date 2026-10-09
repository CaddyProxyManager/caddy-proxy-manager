import { describe, expect, it } from 'bun:test';
import { tabFromPath, tabPath } from '@/components/ui/useTabRoute';

const TABS = ['events', 'plugins', 'settings'] as const;

describe('tabFromPath', () => {
  it('reads the tab from the segment after the base', () => {
    expect(tabFromPath('/waf/plugins', '/waf', TABS, 'events')).toBe('plugins');
  });

  it('is the fallback at the base, for an unknown segment, or under another base', () => {
    expect(tabFromPath('/waf', '/waf', TABS, 'events')).toBe('events');
    expect(tabFromPath('/waf/nonsense', '/waf', TABS, 'events')).toBe('events');
    expect(tabFromPath('/alerts/plugins', '/waf', TABS, 'events')).toBe('events');
    expect(tabFromPath('/wafx/plugins', '/waf', TABS, 'events')).toBe('events');
  });

  it('ignores anything past the tab', () => {
    expect(tabFromPath('/waf/plugins/extra', '/waf', TABS, 'events')).toBe('plugins');
  });
});

describe('tabPath', () => {
  it('keeps the default tab at the bare path', () => {
    expect(tabPath('/waf', 'events', 'events')).toBe('/waf');
    expect(tabPath('/waf', 'plugins', 'events')).toBe('/waf/plugins');
  });
});
