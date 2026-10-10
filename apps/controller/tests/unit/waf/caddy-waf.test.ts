/**
 * With WAF on but CRS off, no @-prefixed Include may appear: those resolve only from the embedded
 * coraza-coreruleset filesystem, mounted when load_owasp_crs=true, and fail the config load.
 */
import { describe, it, expect } from 'bun:test';
import {
  buildWafHandler,
  CORAZA_MAX_BODY_LIMIT,
  droppedWafDirectiveDetails,
  filterCustomDirectives as filterCustomDirectivesWith,
  findCrsPluginRejections,
  findInvalidBodyLimitDirective,
  parseBodyLimitMib,
  resolveEffectiveWaf,
} from '../../../src/lib/waf/caddy';
import { DomainError } from '../../../src/lib/errors/domain-error';

// Strict: this file holds the allowlist's expectations; the lenient mode is tested with the filter.
const filterCustomDirectives = (raw: string | null | undefined) =>
  filterCustomDirectivesWith(raw, { strictDirectives: true });

const baseWaf = {
  enabled: true,
  mode: 'On' as const,
  load_owasp_crs: false,
  custom_directives: '',
  strict_directives: true,
};

// Mode is interpolated into SecLang and stored unvalidated, so an unknown one would smuggle
// directives past the allowlist.

describe('buildWafHandler - SecRuleEngine mode sanitising', () => {
  function directives(mode: string): string {
    const handler = buildWafHandler({
      ...baseWaf,
      mode: mode as typeof baseWaf.mode,
      load_owasp_crs: false,
    });
    return handler.directives as string;
  }

  it('passes through the three real Coraza engine modes', () => {
    expect(directives('On')).toContain('SecRuleEngine On');
    expect(directives('Off')).toContain('SecRuleEngine Off');
    expect(directives('DetectionOnly')).toContain('SecRuleEngine DetectionOnly');
  });

  it('falls back to On for an unrecognised mode', () => {
    expect(directives('bogus')).toContain('SecRuleEngine On');
  });

  it('does not let a newline in mode inject extra directives', () => {
    const out = directives('On\nSecRuleRemoveById 1-999999');
    expect(out).toContain('SecRuleEngine On');
    expect(out).not.toContain('SecRuleRemoveById 1-999999');
  });

  it('always emits the audit log parts the event parser depends on', () => {
    const out = directives('On');
    // waf-log-parser reads part H for rule attribution.
    expect(out).toContain('SecAuditLogParts ABFHZ');
    expect(out).toContain('SecAuditLog /logs/waf-audit.log');
    expect(out).toContain('SecAuditLogFormat JSON');
  });
});

// ---------------------------------------------------------------------------
// Regression: @-prefixed paths must not appear without load_owasp_crs
// ---------------------------------------------------------------------------

describe('buildWafHandler - without OWASP CRS', () => {
  it('does NOT include @coraza.conf-recommended when load_owasp_crs is false', () => {
    const handler = buildWafHandler({ ...baseWaf, load_owasp_crs: false });
    expect(handler.directives).not.toContain('@coraza.conf-recommended');
  });

  it('does NOT include any @-prefixed Include when load_owasp_crs is false', () => {
    const handler = buildWafHandler({ ...baseWaf, load_owasp_crs: false });
    expect(handler.directives).not.toMatch(/Include @/);
  });

  it('does NOT set load_owasp_crs field on handler when disabled', () => {
    const handler = buildWafHandler({ ...baseWaf, load_owasp_crs: false });
    expect(handler.load_owasp_crs).toBeUndefined();
  });

  it('still emits SecRuleEngine directive', () => {
    const handler = buildWafHandler({ ...baseWaf, mode: 'On', load_owasp_crs: false });
    expect(handler.directives).toContain('SecRuleEngine On');
  });

  it('still emits SecRuleEngine Off in DetectionOnly-like mode', () => {
    const handler = buildWafHandler({ ...baseWaf, mode: 'Off', load_owasp_crs: false });
    expect(handler.directives).toContain('SecRuleEngine Off');
  });

  it('includes custom directives when provided', () => {
    const directive =
      'SecRule REQUEST_HEADERS:User-Agent "@contains leakix.net" "id:9002,phase:1,deny,status:403,log"';
    const handler = buildWafHandler({
      ...baseWaf,
      load_owasp_crs: false,
      custom_directives: directive,
    });
    expect(handler.directives).toContain(directive);
  });

  it('does not append empty/whitespace-only custom_directives', () => {
    const handler = buildWafHandler({
      ...baseWaf,
      load_owasp_crs: false,
      custom_directives: '   ',
    });
    expect((handler.directives as string).trimEnd()).not.toMatch(/\s+$/);
  });

  it('allows request body limit directives from custom directives', () => {
    const directives = [
      'SecRequestBodyLimit 536870912',
      'SecRequestBodyNoFilesLimit 536870912',
    ].join('\n');
    const handler = buildWafHandler({ ...baseWaf, custom_directives: directives });
    expect(handler.directives).toContain('SecRequestBodyLimit 536870912');
    expect(handler.directives).toContain('SecRequestBodyNoFilesLimit 536870912');
  });

  // Coraza builds the WAF as Caddy loads the config, so one bad value rejects the whole document.
  it('drops body limits Coraza would refuse rather than breaking the config load', () => {
    const handler = buildWafHandler({
      ...baseWaf,
      custom_directives: [
        'SecRequestBodyLimit 10737418240',
        'SecRequestBodyInMemoryLimit 0',
        'SecRequestBodyLimit 536870912',
      ].join('\n'),
    });
    expect(handler.directives).not.toContain('10737418240');
    expect(handler.directives).not.toContain('SecRequestBodyInMemoryLimit 0');
    expect(handler.directives).toContain('SecRequestBodyLimit 536870912');
  });

  it("accepts a body limit exactly at Coraza's 1 GiB ceiling", () => {
    const handler = buildWafHandler({
      ...baseWaf,
      custom_directives: `SecRequestBodyLimit ${CORAZA_MAX_BODY_LIMIT}`,
    });
    expect(handler.directives).toContain(`SecRequestBodyLimit ${CORAZA_MAX_BODY_LIMIT}`);
  });

  it('allows related constrained request body limit directives', () => {
    const directives = [
      'SecRequestBodyInMemoryLimit 131072',
      'SecRequestBodyLimitAction ProcessPartial',
    ].join('\n');
    const handler = buildWafHandler({ ...baseWaf, custom_directives: directives });
    expect(handler.directives).toContain('SecRequestBodyInMemoryLimit 131072');
    expect(handler.directives).toContain('SecRequestBodyLimitAction ProcessPartial');
  });

  it('still rejects request body directives that can disable inspection', () => {
    const handler = buildWafHandler({
      ...baseWaf,
      custom_directives: 'SecRequestBodyAccess Off',
    });
    expect(handler.directives).not.toContain('SecRequestBodyAccess Off');
  });
});

// ---------------------------------------------------------------------------
// With OWASP CRS enabled
// ---------------------------------------------------------------------------

describe('buildWafHandler - with OWASP CRS', () => {
  it('includes @coraza.conf-recommended when load_owasp_crs is true', () => {
    const handler = buildWafHandler({ ...baseWaf, load_owasp_crs: true });
    expect(handler.directives).toContain('Include @coraza.conf-recommended');
  });

  it('includes @crs-setup.conf.example when load_owasp_crs is true', () => {
    const handler = buildWafHandler({ ...baseWaf, load_owasp_crs: true });
    expect(handler.directives).toContain('Include @crs-setup.conf.example');
  });

  it('includes @owasp_crs/*.conf when load_owasp_crs is true', () => {
    const handler = buildWafHandler({ ...baseWaf, load_owasp_crs: true });
    expect(handler.directives).toContain('Include @owasp_crs/*.conf');
  });

  it('sets load_owasp_crs=true on the handler object', () => {
    const handler = buildWafHandler({ ...baseWaf, load_owasp_crs: true });
    expect(handler.load_owasp_crs).toBe(true);
  });

  it('@coraza.conf-recommended appears BEFORE CRS includes', () => {
    const handler = buildWafHandler({ ...baseWaf, load_owasp_crs: true });
    const directives = handler.directives as string;
    const corazaPos = directives.indexOf('@coraza.conf-recommended');
    const crsPos = directives.indexOf('@owasp_crs');
    expect(corazaPos).toBeLessThan(crsPos);
  });
});

// ---------------------------------------------------------------------------
// Excluded rule IDs
// ---------------------------------------------------------------------------

describe('buildWafHandler - excluded_rule_ids', () => {
  it('emits SecRuleRemoveById with single ID', () => {
    const handler = buildWafHandler({ ...baseWaf, excluded_rule_ids: [941100] });
    expect(handler.directives).toContain('SecRuleRemoveById 941100');
  });

  it('emits SecRuleRemoveById with multiple IDs space-separated', () => {
    const handler = buildWafHandler({ ...baseWaf, excluded_rule_ids: [941100, 942200, 943300] });
    expect(handler.directives).toContain('SecRuleRemoveById 941100 942200 943300');
  });

  it('omits SecRuleRemoveById when excluded_rule_ids is empty', () => {
    const handler = buildWafHandler({ ...baseWaf, excluded_rule_ids: [] });
    expect(handler.directives).not.toContain('SecRuleRemoveById');
  });

  it('omits SecRuleRemoveById when excluded_rule_ids is undefined', () => {
    const handler = buildWafHandler({ ...baseWaf });
    expect(handler.directives).not.toContain('SecRuleRemoveById');
  });
});

// ---------------------------------------------------------------------------
// Handler structure
// ---------------------------------------------------------------------------

describe('buildWafHandler - handler structure', () => {
  it('always sets handler="waf"', () => {
    expect(buildWafHandler(baseWaf).handler).toBe('waf');
  });

  it('directives is a non-empty string', () => {
    const handler = buildWafHandler(baseWaf);
    expect(typeof handler.directives).toBe('string');
    expect((handler.directives as string).length).toBeGreaterThan(0);
  });

  it('always includes audit log directives', () => {
    const handler = buildWafHandler(baseWaf);
    expect(handler.directives).toContain('SecAuditEngine RelevantOnly');
    expect(handler.directives).toContain('SecAuditLog /logs/waf-audit.log');
    expect(handler.directives).toContain('SecAuditLogFormat JSON');
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveWaf
// ---------------------------------------------------------------------------

const globalWaf = {
  enabled: true,
  mode: 'On' as const,
  load_owasp_crs: false,
  strict_directives: true,
  custom_directives:
    'SecRule REQUEST_HEADERS:User-Agent "@contains leakix.net" "id:9002,phase:1,deny,status:403,log"',
};

describe('resolveEffectiveWaf - no per-host config', () => {
  it('returns null when both global and host are null', () => {
    expect(resolveEffectiveWaf(null, null)).toBeNull();
  });

  it('returns null when global is disabled and host is null', () => {
    expect(resolveEffectiveWaf({ ...globalWaf, enabled: false }, null)).toBeNull();
  });

  it('applies global WAF when host has no per-host config (null)', () => {
    const result = resolveEffectiveWaf(globalWaf, null);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.custom_directives).toContain('9002');
  });

  it('applies global WAF when host config is undefined', () => {
    const result = resolveEffectiveWaf(globalWaf, undefined);
    expect(result).not.toBeNull();
    expect(result!.custom_directives).toContain('9002');
  });
});

describe('resolveEffectiveWaf - merge mode (regression: host.enabled=false must opt out)', () => {
  it('returns null when host explicitly disables WAF in merge mode (the bug fix)', () => {
    const result = resolveEffectiveWaf(globalWaf, { enabled: false, waf_mode: 'merge' });
    expect(result).toBeNull();
  });

  it('returns null when host.enabled=false with no waf_mode set (defaults to merge)', () => {
    const result = resolveEffectiveWaf(globalWaf, { enabled: false });
    expect(result).toBeNull();
  });

  it('merges host settings on top of global when host is enabled', () => {
    const result = resolveEffectiveWaf(globalWaf, {
      enabled: true,
      waf_mode: 'merge',
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: 'SecRule ARGS "@contains evil" "id:9003,deny"',
    });
    expect(result).not.toBeNull();
    expect(result!.load_owasp_crs).toBe(true);
    expect(result!.custom_directives).toContain('9002');
    expect(result!.custom_directives).toContain('9003');
  });

  it('merge result has enabled=true', () => {
    const result = resolveEffectiveWaf(globalWaf, { enabled: true, waf_mode: 'merge' });
    expect(result!.enabled).toBe(true);
  });

  it('merged excluded_rule_ids combines global and host lists', () => {
    const global = { ...globalWaf, excluded_rule_ids: [941100] };
    const result = resolveEffectiveWaf(global, {
      enabled: true,
      waf_mode: 'merge',
      excluded_rule_ids: [942200],
    });
    expect(result!.excluded_rule_ids).toContain(941100);
    expect(result!.excluded_rule_ids).toContain(942200);
  });
});

describe('resolveEffectiveWaf - override mode', () => {
  it('returns null when host.enabled=false in override mode', () => {
    const result = resolveEffectiveWaf(globalWaf, { enabled: false, waf_mode: 'override' });
    expect(result).toBeNull();
  });

  it('uses only host config in override mode, ignores global custom_directives', () => {
    const result = resolveEffectiveWaf(globalWaf, {
      enabled: true,
      waf_mode: 'override',
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: 'SecRule ARGS "@contains evil" "id:9003,deny"',
    });
    expect(result).not.toBeNull();
    expect(result!.custom_directives).toBe('SecRule ARGS "@contains evil" "id:9003,deny"');
    expect(result!.custom_directives).not.toContain('9002');
    expect(result!.load_owasp_crs).toBe(true);
  });

  it('host-only WAF with no global applies correctly', () => {
    const result = resolveEffectiveWaf(null, { enabled: true, waf_mode: 'override', mode: 'On' });
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dedicated request body limit settings (#252). Every value must pass Coraza's checks (<= 1 GiB,
// in-memory <= request) or the whole config document is rejected.

describe('buildWafHandler - request body limit settings', () => {
  it('emits the configured limits as SecLang directives', () => {
    const handler = buildWafHandler({
      ...baseWaf,
      request_body_limit: 536870912,
      request_body_in_memory_limit: 1048576,
      request_body_limit_action: 'ProcessPartial',
    });
    const directives = handler.directives as string;
    expect(directives).toContain('SecRequestBodyLimit 536870912');
    expect(directives).toContain('SecRequestBodyInMemoryLimit 1048576');
    expect(directives).toContain('SecRequestBodyLimitAction ProcessPartial');
  });

  it('emits nothing when the limits are unset', () => {
    const directives = buildWafHandler(baseWaf).directives as string;
    expect(directives).not.toContain('SecRequestBodyLimit');
    expect(directives).not.toContain('SecRequestBodyLimitAction');
  });

  it('overrides the CRS default by ordering the limit after the include', () => {
    const directives = buildWafHandler({
      ...baseWaf,
      load_owasp_crs: true,
      request_body_limit: 536870912,
    }).directives as string;
    const includeAt = directives.indexOf('Include @coraza.conf-recommended');
    const limitAt = directives.indexOf('SecRequestBodyLimit 536870912');
    expect(includeAt).toBeGreaterThanOrEqual(0);
    expect(limitAt).toBeGreaterThan(includeAt);
  });

  it('lets custom directives win over the settings fields', () => {
    const directives = buildWafHandler({
      ...baseWaf,
      request_body_limit: 536870912,
      custom_directives: 'SecRequestBodyLimit 268435456',
    }).directives as string;
    expect(directives.indexOf('SecRequestBodyLimit 268435456')).toBeGreaterThan(
      directives.indexOf('SecRequestBodyLimit 536870912'),
    );
  });

  it('ignores out-of-range and unknown values instead of emitting them', () => {
    const directives = buildWafHandler({
      ...baseWaf,
      request_body_limit: 10737418240,
      request_body_in_memory_limit: 0,
      request_body_limit_action: 'Off' as never,
    }).directives as string;
    expect(directives).not.toContain('SecRequestBodyLimit');
    expect(directives).not.toContain('SecRequestBodyLimitAction');
  });

  // Coraza checks the final values, so the corrective line at the end wins.
  it('clamps an in-memory limit that would exceed the request limit', () => {
    const directives = buildWafHandler({
      ...baseWaf,
      load_owasp_crs: true,
      custom_directives: 'SecRequestBodyInMemoryLimit 268435456',
    }).directives as string;
    // CRS caps the request body at 12.5 MiB, so 256 MiB in memory is invalid.
    expect(directives.trimEnd().endsWith('SecRequestBodyInMemoryLimit 13107200')).toBe(true);
  });

  it('leaves a valid limit pair untouched', () => {
    const directives = buildWafHandler({
      ...baseWaf,
      load_owasp_crs: true,
      request_body_limit: 536870912,
      request_body_in_memory_limit: 268435456,
    }).directives as string;
    expect(directives.match(/SecRequestBodyInMemoryLimit/g)).toHaveLength(1);
  });
});

describe('resolveEffectiveWaf - body limits', () => {
  const globalWaf = {
    enabled: true,
    mode: 'On' as const,
    load_owasp_crs: true,
    custom_directives: '',
    request_body_limit: 134217728,
    request_body_limit_action: 'Reject' as const,
  };

  it('lets a host override the global limit in merge mode', () => {
    const effective = resolveEffectiveWaf(globalWaf, {
      enabled: true,
      request_body_limit: 536870912,
    });
    expect(effective?.request_body_limit).toBe(536870912);
    expect(effective?.request_body_limit_action).toBe('Reject');
  });

  it('inherits the global limit when the host leaves it unset', () => {
    const effective = resolveEffectiveWaf(globalWaf, { enabled: true });
    expect(effective?.request_body_limit).toBe(134217728);
  });

  it('does not inherit the global limit in override mode', () => {
    const effective = resolveEffectiveWaf(globalWaf, { enabled: true, waf_mode: 'override' });
    expect(effective?.request_body_limit).toBeUndefined();
  });
});

describe('findInvalidBodyLimitDirective', () => {
  it('reports the offending line so the user gets a precise error', () => {
    expect(findInvalidBodyLimitDirective('SecRequestBodyLimit 10737418240')).toBe(
      'SecRequestBodyLimit 10737418240',
    );
  });

  it('passes in-range limits, comments and unrelated directives', () => {
    expect(
      findInvalidBodyLimitDirective(
        [
          '# raise the upload ceiling',
          'SecRequestBodyLimit 536870912',
          'SecRule ARGS "@contains evil" "id:9001,deny"',
        ].join('\n'),
      ),
    ).toBeNull();
    expect(findInvalidBodyLimitDirective('')).toBeNull();
    expect(findInvalidBodyLimitDirective(undefined)).toBeNull();
  });
});

// A silently dropped line reads as a CPM bug rather than a refused directive (upstream #146).
describe('filterCustomDirectives', () => {
  it('keeps allowed directives, comments and blank lines', () => {
    const raw = [
      '# raise the ceiling',
      '',
      'SecRule ARGS "@contains evil" "id:9001,deny"',
      'SecAction "id:9002,pass,nolog"',
      'SecMarker END_CHECKS',
      'SecDefaultAction "phase:1,log,auditlog,pass"',
      'SecRequestBodyLimit 536870912',
      'SecRequestBodyLimitAction ProcessPartial',
    ].join('\n');

    const { kept, dropped } = filterCustomDirectives(raw);

    expect(dropped).toEqual([]);
    expect(kept.join('\n')).toBe(raw);
  });

  it('names each dropped line and why it went', () => {
    const { kept, dropped } = filterCustomDirectives(
      [
        'Include /etc/passwd',
        'SecRuleUpdateActionById 9001 "deny"',
        'SecRuleEngine Off',
        'SecRequestBodyLimit 10737418240',
        'SecRequestBodyAccess Off',
        'SecRule ARGS "@rx x" "id:9003,ctl:ruleEngine=Off"',
        'SecRule ARGS "@contains evil" "id:9004,deny"',
      ].join('\n'),
    );

    expect(kept).toEqual(['SecRule ARGS "@contains evil" "id:9004,deny"']);
    expect(dropped).toEqual([
      { line: 'Include /etc/passwd', reason: 'wafDirectiveDroppedInclude' },
      { line: 'SecRuleUpdateActionById 9001 "deny"', reason: 'wafDirectiveDroppedRuleMutation' },
      { line: 'SecRuleEngine Off', reason: 'wafDirectiveDroppedRuleMutation' },
      { line: 'SecRequestBodyLimit 10737418240', reason: 'wafDirectiveDroppedBodyLimit' },
      {
        line: 'SecRequestBodyAccess Off',
        reason: 'wafDirectiveDroppedNotAllowed',
        params: { name: 'SecRequestBodyAccess' },
      },
      {
        line: 'SecRule ARGS "@rx x" "id:9003,ctl:ruleEngine=Off"',
        reason: 'wafDirectiveDroppedCtlRuleEngine',
      },
    ]);
  });

  it('reads nothing out of blank input', () => {
    expect(filterCustomDirectives('')).toEqual({ kept: [], dropped: [] });
    expect(filterCustomDirectives('   ')).toEqual({ kept: [], dropped: [] });
    expect(filterCustomDirectives(undefined)).toEqual({ kept: [], dropped: [] });
  });

  it('renders each reason as a sentence naming the line', () => {
    const { dropped } = filterCustomDirectives('Include /etc/passwd');
    expect(droppedWafDirectiveDetails(dropped)).toEqual([
      '"Include /etc/passwd" - Include reads arbitrary files from the container filesystem',
    ]);
    const outOfRange = filterCustomDirectives('SecRequestBodyLimit 10737418240').dropped;
    expect(droppedWafDirectiveDetails(outOfRange)[0]).toContain('between 1024 and 1073741824');
  });
});

// Coraza joins continued lines before evaluating, so the allowlist must too (upstream #149).
describe('filterCustomDirectives - multi-line directives', () => {
  it('keeps a rule continued across lines, verbatim', () => {
    const raw = [
      'SecRule REQUEST_FILENAME "@beginsWith /remote.php/dav" \\',
      '    "id:9500,\\',
      '    phase:1,\\',
      '    pass,\\',
      '    nolog,\\',
      '    ctl:ruleRemoveTargetById=920420;REQUEST_HEADERS:Content-Type"',
    ].join('\n');
    const { kept, dropped } = filterCustomDirectives(raw);
    expect(dropped).toEqual([]);
    expect(kept.join('\n')).toBe(raw);
  });

  it('skips a comment in the middle of a rule, as Coraza does', () => {
    const raw = ['SecRule ARGS "@rx x" \\', '# why', '    "id:9501,pass,nolog"'].join('\n');
    expect(filterCustomDirectives(raw)).toEqual({ kept: raw.split('\n'), dropped: [] });
  });

  it('judges the joined rule, so ctl:ruleEngine split across lines is still caught', () => {
    const { kept, dropped } = filterCustomDirectives(
      ['SecRule ARGS "@rx x" "id:9502,\\', 'ctl:ruleEngine=Off"'].join('\n'),
    );
    expect(kept).toEqual([]);
    expect(dropped).toEqual([
      {
        line: 'SecRule ARGS "@rx x" "id:9502,ctl:ruleEngine=Off"',
        reason: 'wafDirectiveDroppedCtlRuleEngine',
      },
    ]);
  });

  it('catches ctl:ruleEngine with whitespace around the colon', () => {
    const { dropped } = filterCustomDirectives(
      'SecRule ARGS "@rx x" "id:9503,ctl: ruleEngine=Off"',
    );
    expect(dropped.map((entry) => entry.reason)).toEqual(['wafDirectiveDroppedCtlRuleEngine']);
  });

  it('drops a continuation the input never closes', () => {
    const { kept, dropped } = filterCustomDirectives(
      ['SecRule ARGS "@rx x" "id:9504,pass,nolog"', 'SecAction "id:9505,pass" \\'].join('\n'),
    );
    expect(kept).toEqual(['SecRule ARGS "@rx x" "id:9504,pass,nolog"']);
    expect(dropped).toEqual([
      { line: 'SecAction "id:9505,pass" \\', reason: 'wafDirectiveDroppedUnterminated' },
    ]);
  });

  it('refuses a disallowed directive hidden behind a continuation', () => {
    const { dropped } = filterCustomDirectives(['Include \\', '/etc/passwd'].join('\n'));
    expect(dropped.map((entry) => entry.reason)).toEqual(['wafDirectiveDroppedInclude']);
  });

  it('finds an out-of-range body limit split across lines', () => {
    expect(findInvalidBodyLimitDirective('SecRequestBodyLimit \\\n10737418240')).toBe(
      'SecRequestBodyLimit 10737418240',
    );
  });
});

describe('buildWafHandler - presets', () => {
  const presets = new Map([
    [1, 'SecRule ARGS "@rx one" "id:9601,pass,nolog"'],
    [2, 'SecRule ARGS "@rx two" "id:9602,pass,nolog"'],
  ]);

  it('loads presets after crs-setup and before the CRS rules', () => {
    const directives = buildWafHandler(
      { ...baseWaf, load_owasp_crs: true, preset_ids: [2, 1] },
      presets,
    ).directives as string;
    const setup = directives.indexOf('@crs-setup.conf.example');
    const two = directives.indexOf('id:9602');
    const one = directives.indexOf('id:9601');
    const rules = directives.indexOf('@owasp_crs/*.conf');
    expect(setup).toBeLessThan(two);
    expect(two).toBeLessThan(one);
    expect(one).toBeLessThan(rules);
  });

  it('emits presets without the CRS too', () => {
    const directives = buildWafHandler({ ...baseWaf, preset_ids: [1] }, presets)
      .directives as string;
    expect(directives).toContain('id:9601');
    expect(directives).not.toContain('@owasp_crs');
  });

  it('emits a preset once, and nothing for an unknown id', () => {
    const directives = buildWafHandler({ ...baseWaf, preset_ids: [1, 1, 99] }, presets)
      .directives as string;
    expect(directives.split('id:9601').length).toBe(2);
  });

  it('still drops what the allowlist refuses, for a row stored before a check existed', () => {
    const directives = buildWafHandler(
      { ...baseWaf, preset_ids: [3] },
      new Map([[3, 'SecRuleEngine Off\nSecRule ARGS "@rx x" "id:9603,pass,nolog"']]),
    ).directives as string;
    expect(directives).toContain('id:9603');
    expect(directives).toContain('SecRuleEngine On');
    expect(directives).not.toContain('SecRuleEngine Off');
  });
});

describe('resolveEffectiveWaf - presets', () => {
  const global = { ...baseWaf, preset_ids: [1, 2] };

  it('merge mode adds the host presets to the global ones, once each', () => {
    expect(resolveEffectiveWaf(global, { enabled: true, preset_ids: [2, 3] })?.preset_ids).toEqual([
      1, 2, 3,
    ]);
  });

  it('override mode uses the host presets alone', () => {
    expect(
      resolveEffectiveWaf(global, { enabled: true, waf_mode: 'override', preset_ids: [3] })
        ?.preset_ids,
    ).toEqual([3]);
  });

  it('a host without its own config inherits the global presets', () => {
    expect(resolveEffectiveWaf(global, null)?.preset_ids).toEqual([1, 2]);
  });
});

describe('buildWafHandler - CRS plugins', () => {
  const plugins = new Map([
    [
      1,
      {
        config: 'SecAction "id:9507010,phase:1,pass,nolog"',
        before: 'SecRule ARGS "@rx one" "id:9507100,phase:1,pass,nolog"',
        after: '',
      },
    ],
    [
      2,
      {
        config: 'SecAction "id:9508010,phase:1,pass,nolog"',
        before: 'SecRule ARGS "@rx two" "id:9508100,phase:1,pass,nolog"',
        after: 'SecRuleUpdateTargetById 942100 "!ARGS:two"',
      },
    ],
  ]);
  const presets = new Map([[5, 'SecRule ARGS "@rx p" "id:9601,pass,nolog"']]);

  it('loads configs, then befores, then the CRS rules, then afters', () => {
    const directives = buildWafHandler(
      { ...baseWaf, load_owasp_crs: true, plugin_ids: [2, 1], preset_ids: [5] },
      presets,
      plugins,
    ).directives as string;
    const at = (needle: string) => directives.indexOf(needle);
    expect(at('@crs-setup.conf.example')).toBeLessThan(at('id:9508010'));
    expect(at('id:9508010')).toBeLessThan(at('id:9507010'));
    expect(at('id:9507010')).toBeLessThan(at('id:9508100'));
    expect(at('id:9508100')).toBeLessThan(at('id:9507100'));
    expect(at('id:9507100')).toBeLessThan(at('id:9601'));
    expect(at('id:9601')).toBeLessThan(at('@owasp_crs/*.conf'));
    expect(at('@owasp_crs/*.conf')).toBeLessThan(at('SecRuleUpdateTargetById 942100'));
    expect(at('SecRuleUpdateTargetById 942100')).toBeLessThan(at('SecRuleEngine On'));
  });

  it('leaves plugins out without the CRS, since they tune its rules', () => {
    const directives = buildWafHandler({ ...baseWaf, plugin_ids: [1] }, new Map(), plugins)
      .directives as string;
    expect(directives).not.toContain('id:9507');
  });

  it('emits a plugin once, and nothing for an unknown id', () => {
    const directives = buildWafHandler(
      { ...baseWaf, load_owasp_crs: true, plugin_ids: [1, 1, 99] },
      new Map(),
      plugins,
    ).directives as string;
    expect(directives.split('id:9507100').length).toBe(2);
  });

  it('merge mode adds the host plugins to the global ones; override uses the host alone', () => {
    const global = { ...baseWaf, plugin_ids: [1, 2] };
    expect(resolveEffectiveWaf(global, { enabled: true, plugin_ids: [2, 3] })?.plugin_ids).toEqual([
      1, 2, 3,
    ]);
    expect(
      resolveEffectiveWaf(global, { enabled: true, waf_mode: 'override', plugin_ids: [3] })
        ?.plugin_ids,
    ).toEqual([3]);
  });
});

describe('findCrsPluginRejections', () => {
  const range = { start: 9507000, end: 9507999 };

  it('accepts what registered plugins use', () => {
    const plugin = [
      '# comment',
      'SecRule REQUEST_FILENAME "@endsWith /wp-login.php" \\',
      '    "id:9507101,phase:2,pass,nolog,ctl:ruleRemoveTargetById=920273;ARGS:pwd,chain"',
      '    SecRule ARGS:action "@streq resetpass" "t:none"',
      'SecAction "id:9507020,phase:1,pass,nolog,setvar:tx.x=1"',
      'SecMarker "END-WORDPRESS"',
      'SecRuleUpdateTargetById 942100 "!ARGS:content"',
      'SecRuleRemoveById 942200',
    ].join('\n');
    expect(findCrsPluginRejections(plugin, range)).toEqual([]);
  });

  it('refuses a rule that reads a file, which an inlined plugin does not have', () => {
    const [rejection] = findCrsPluginRejections(
      'SecRule TX:0 "@inspectFile fake-bot.lua" "id:9507110,phase:1,deny"',
      range,
    );
    expect(rejection.reason).toBe('crsPluginNeedsFile');
    expect(
      findCrsPluginRejections('SecRule ARGS "@pmFromFile x.data" "id:9507111,deny"', range)[0]
        .reason,
    ).toBe('crsPluginNeedsFile');
  });

  it('refuses a rule id outside the registered range, but not a ctl target id', () => {
    expect(
      findCrsPluginRejections('SecRule ARGS "@rx x" "id:942100,phase:1,pass"', range)[0].reason,
    ).toBe('crsPluginRuleIdOutOfRange');
    expect(
      findCrsPluginRejections(
        'SecRule ARGS "@rx x" "id:9507200,phase:1,pass,ctl:ruleRemoveById=942100"',
        range,
      ),
    ).toEqual([]);
  });

  it('refuses engine and file directives, and ctl:ruleEngine', () => {
    const reasons = findCrsPluginRejections(
      [
        'Include /etc/passwd',
        'SecRuleEngine Off',
        'SecAuditLog /tmp/x',
        'SecRule ARGS "@rx x" "id:9507300,phase:1,pass,ctl: ruleEngine=Off"',
      ].join('\n'),
      range,
    ).map((rejection) => rejection.reason);
    expect(reasons).toEqual([
      'crsPluginDirectiveNotAllowed',
      'crsPluginDirectiveNotAllowed',
      'crsPluginDirectiveNotAllowed',
      'wafDirectiveDroppedCtlRuleEngine',
    ]);
  });

  it('refuses what Coraza cannot compile: persistent collections and unbalanced quotes', () => {
    const reasons = (text: string) =>
      findCrsPluginRejections(text, range).map((rejection) => rejection.reason);
    expect(reasons('SecRule IP:DOS_BLOCK "@eq 1" "id:9507400,phase:1,deny"')).toEqual([
      'crsPluginPersistentCollection',
    ]);
    expect(reasons('SecRule ARGS|&SESSION:x "@eq 1" "id:9507401,phase:1,deny"')).toEqual([
      'crsPluginPersistentCollection',
    ]);
    expect(reasons('SecAction "id:9507402,phase:1,pass,setvar:ip.counter=+1"')).toEqual([
      'crsPluginPersistentCollection',
    ]);
    // google-oauth2 1.0.0 leaves its action list open before a chain.
    expect(reasons('SecRule TX:X "@eq 1" "id:9507403,phase:2,pass,chain')).toEqual([
      'crsPluginUnbalancedQuotes',
    ]);
    // An escaped quote inside a message is not one.
    expect(
      reasons(String.raw`SecRule ARGS "@rx x" "id:9507404,phase:1,pass,msg:'a \" b'"`),
    ).toEqual([]);
    // REMOTE_ADDR and TX.ip-like names are not the IP collection.
    expect(
      reasons(
        'SecRule REMOTE_ADDR "@ipMatch 10.0.0.0/8" "id:9507405,phase:1,pass,setvar:tx.ip_ok=1"',
      ),
    ).toEqual([]);
  });

  it('refuses a directive left open, which would swallow what follows it', () => {
    expect(
      findCrsPluginRejections('SecRule ARGS "@rx x" \\', range).map((entry) => entry.reason),
    ).toEqual(['wafDirectiveDroppedUnterminated']);
  });
});

describe('parseBodyLimitMib', () => {
  it('converts MiB to bytes and treats blank as unset', () => {
    expect(parseBodyLimitMib('512', 'wafRequestBodyLimitInvalid')).toBe(536870912);
    expect(parseBodyLimitMib('', 'wafRequestBodyLimitInvalid')).toBeUndefined();
    expect(parseBodyLimitMib('  ', 'wafRequestBodyLimitInvalid')).toBeUndefined();
    expect(parseBodyLimitMib(null, 'wafRequestBodyLimitInvalid')).toBeUndefined();
  });

  it('rejects values Coraza would refuse', () => {
    expect(() => parseBodyLimitMib('1025', 'wafRequestBodyLimitInvalid')).toThrow(
      /between 1 and 1024/,
    );
    expect(() => parseBodyLimitMib('0', 'wafRequestBodyLimitInvalid')).toThrow();
    expect(() => parseBodyLimitMib('1.5', 'wafRequestBodyLimitInvalid')).toThrow();
    expect(() => parseBodyLimitMib('abc', 'wafRequestBodyLimitInvalid')).toThrow();
  });

  it('raises the code it was given, worded as the form used to word it', () => {
    const cases = [
      ['wafRequestBodyLimitInvalid', 'Request body limit'],
      ['wafInMemoryBodyLimitInvalid', 'In-memory body limit'],
      ['hostWafRequestBodyLimitInvalid', 'WAF request body limit'],
      ['hostWafInMemoryBodyLimitInvalid', 'WAF in-memory body limit'],
    ] as const;
    for (const [code, label] of cases) {
      let caught: unknown;
      try {
        parseBodyLimitMib('2048', code);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe(code);
      expect((caught as DomainError).message).toBe(
        `${label} must be a whole number of MiB between 1 and 1024`,
      );
    }
  });
});
