import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { buildWafHandler, resolveEffectiveWaf } from '@/src/lib/waf/caddy';
import { CRS_VERSION, crsTuningDirectives, effectiveTuning } from '@/src/lib/waf/tuning';
import type { WafSettings } from '@/src/lib/settings';

const base: WafSettings = {
  enabled: true,
  mode: 'On',
  load_owasp_crs: true,
  custom_directives: '',
};

describe('CRS tuning', () => {
  it('emits nothing at the defaults, so an untuned WAF builds as before', () => {
    expect(crsTuningDirectives({})).toEqual([]);
    expect(
      crsTuningDirectives({
        paranoia_level: 1,
        inbound_anomaly_threshold: 5,
        outbound_anomaly_threshold: 4,
      }),
    ).toEqual([]);
  });

  it('sets the blocking and detection levels and the thresholds', () => {
    const lines = crsTuningDirectives({
      paranoia_level: 2,
      log_next_paranoia_level: true,
      inbound_anomaly_threshold: 10,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('id:900000');
    expect(lines[0]).toContain('setvar:tx.blocking_paranoia_level=2');
    expect(lines[1]).toContain('setvar:tx.detection_paranoia_level=3');
    expect(lines[2]).toContain('setvar:tx.inbound_anomaly_score_threshold=10');
    expect(lines[2]).toContain('setvar:tx.outbound_anomaly_score_threshold=4');
  });

  it('caps the logged level at 4 and reads an out-of-range value as the default', () => {
    expect(effectiveTuning({ paranoia_level: 4, log_next_paranoia_level: true })).toMatchObject({
      paranoiaLevel: 4,
      detectionParanoiaLevel: 4,
    });
    expect(
      effectiveTuning({ paranoia_level: 9, inbound_anomaly_threshold: 0 } as never),
    ).toMatchObject({ paranoiaLevel: 1, inboundThreshold: 5 });
  });

  it('sits after crs-setup and before the rules, and only with the CRS', () => {
    const tuned = { ...base, paranoia_level: 3 };
    const directives = String(buildWafHandler(tuned).directives);
    const setup = directives.indexOf('Include @crs-setup.conf.example');
    const level = directives.indexOf('blocking_paranoia_level=3');
    expect(level).toBeGreaterThan(setup);
    expect(level).toBeLessThan(directives.indexOf('Include @owasp_crs/*.conf'));
    expect(String(buildWafHandler({ ...tuned, load_owasp_crs: false }).directives)).not.toContain(
      'paranoia',
    );
  });

  it('reaches hosts that merge with or override the global WAF', () => {
    const global = { ...base, paranoia_level: 2 };
    for (const waf_mode of ['merge', 'override'] as const) {
      const effective = resolveEffectiveWaf(global, {
        enabled: true,
        waf_mode,
        load_owasp_crs: true,
      });
      expect(effective?.paranoia_level).toBe(2);
    }
  });

  it('names the rule set docker/caddy/go.mod pins', () => {
    const goMod = readFileSync(join(process.cwd(), '../../docker/caddy/go.mod'), 'utf8');
    expect(goMod).toContain(`github.com/corazawaf/coraza-coreruleset/v4 v${CRS_VERSION}`);
  });
});
