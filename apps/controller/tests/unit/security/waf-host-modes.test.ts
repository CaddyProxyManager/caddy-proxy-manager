import { describe, expect, it } from 'bun:test';
import type { WafSettings } from '@/src/lib/settings';
import { countModes, effectiveWafMode, wafHostModes } from '@/src/lib/security/waf-hosts';

const global: WafSettings = {
  enabled: true,
  mode: 'On',
  load_owasp_crs: true,
  custom_directives: '',
};

describe('effectiveWafMode', () => {
  it('follows the global mode when the host sets none', () => {
    expect(effectiveWafMode(global, null)).toEqual({ mode: 'On', source: 'global' });
    expect(effectiveWafMode({ ...global, mode: 'DetectionOnly' }, { enabled: true })).toEqual({
      mode: 'DetectionOnly',
      source: 'global',
    });
  });

  it('names the host when it runs the WAF while the global one is off', () => {
    expect(effectiveWafMode({ ...global, enabled: false }, { enabled: true })).toEqual({
      mode: 'On',
      source: 'host',
    });
  });

  it('names a host that sets its own mode, opts out, or overrides', () => {
    expect(effectiveWafMode(global, { enabled: true, mode: 'DetectionOnly' })).toEqual({
      mode: 'DetectionOnly',
      source: 'host',
    });
    expect(effectiveWafMode(global, { enabled: false })).toEqual({
      mode: 'Off',
      source: 'hostOff',
    });
    expect(effectiveWafMode(null, { enabled: true, waf_mode: 'override', mode: 'On' })).toEqual({
      mode: 'On',
      source: 'override',
    });
  });

  it('is off with no WAF anywhere', () => {
    expect(effectiveWafMode(null, null)).toEqual({ mode: 'Off', source: 'global' });
  });
});

describe('wafHostModes', () => {
  it('sums events over every domain a host serves, and counts enabled hosts by mode', () => {
    const modes = wafHostModes(
      global,
      [
        { id: 1, name: 'a', domains: ['a.test', 'www.a.test'], enabled: true },
        { id: 2, name: 'b', domains: ['b.test'], enabled: false, waf: { enabled: false } },
      ],
      new Map([
        ['a.test', 3],
        ['www.a.test', 2],
      ]),
    );
    expect(modes.map((m) => m.events7d)).toEqual([5, 0]);
    expect(countModes(modes)).toEqual({ On: 1, DetectionOnly: 0, Off: 0 });
    expect(
      wafHostModes(global, [{ id: 1, name: 'a', domains: [], enabled: true }], null)[0]?.events7d,
    ).toBeNull();
  });
});
