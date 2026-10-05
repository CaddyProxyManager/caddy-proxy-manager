import { describe, expect, it } from 'bun:test';
import {
  ExclusionInputError,
  WAF_EXCLUSION_RULE_ID_BASE,
  type WafExclusionRule,
  exclusionDirectives,
  exclusionsFor,
  normalizeExclusionPath,
  normalizeExclusionTarget,
  validateExclusionRuleId,
} from '@/src/lib/waf/exclusions';
import { buildWafHandler } from '@/src/lib/waf/caddy';
import type { WafSettings } from '@/src/lib/settings';

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ExclusionInputError ? error.code : String(error);
  }
}

const rule = (overrides: Partial<WafExclusionRule>): WafExclusionRule => ({
  id: 1,
  ruleId: 942100,
  proxyHostId: null,
  path: null,
  target: null,
  ...overrides,
});

describe('exclusion rule ids', () => {
  it('accepts a positive id, as a number or text', () => {
    expect(validateExclusionRuleId(942100)).toBe(942100);
    expect(validateExclusionRuleId(' 920350 ')).toBe(920350);
  });

  it('refuses the anomaly decision rules', () => {
    for (const id of [949110, 949111, 959100, 959101]) {
      expect(code(() => validateExclusionRuleId(id))).toBe('wafExclusionRuleProtected');
    }
  });

  it('refuses ids that are not whole positive numbers', () => {
    for (const id of [0, -1, 1.5, 'abc', 2 ** 31, null]) {
      expect(code(() => validateExclusionRuleId(id))).toBe('wafExclusionRuleIdInvalid');
    }
  });
});

describe('exclusion paths', () => {
  it('decodes once and resolves dot segments and repeated slashes', () => {
    expect(normalizeExclusionPath('/api//v1/./upload')).toBe('/api/v1/upload');
    expect(normalizeExclusionPath('/api/v1/../v2/%75pload')).toBe('/api/v2/upload');
    expect(normalizeExclusionPath('/a/b/')).toBe('/a/b/');
  });

  it('keeps a trailing * as a prefix and drops a query', () => {
    expect(normalizeExclusionPath('/files/*')).toBe('/files/*');
    expect(normalizeExclusionPath('/search?q=1')).toBe('/search');
  });

  it('treats blank as no path', () => {
    expect(normalizeExclusionPath('  ')).toBeNull();
    expect(normalizeExclusionPath(null)).toBeNull();
  });

  it('refuses what would break out of the quoted operator', () => {
    for (const path of ['api', '/a b', '/a"b', '/a\\b', '/%{tx.x}', '/a*b', '/%ZZ']) {
      expect(code(() => normalizeExclusionPath(path))).toBe('wafExclusionPathInvalid');
    }
  });
});

describe('exclusion targets', () => {
  it('normalises the collection and keeps the name', () => {
    expect(normalizeExclusionTarget('args:content')).toBe('ARGS:content');
    expect(normalizeExclusionTarget('REQUEST_COOKIES:session_id')).toBe(
      'REQUEST_COOKIES:session_id',
    );
    expect(normalizeExclusionTarget('REQUEST_BODY')).toBe('REQUEST_BODY');
  });

  it('refuses an unknown collection or a name that ends the action list', () => {
    for (const target of ['TX:score', 'ARGS:a,b', 'ARGS:a;b', 'ARGS:"x"', 'ARGS:/re/']) {
      expect(code(() => normalizeExclusionTarget(target))).toBe('wafExclusionTargetInvalid');
    }
  });
});

describe('exclusionsFor', () => {
  const all = [rule({ id: 1 }), rule({ id: 2, proxyHostId: 7 }), rule({ id: 3, proxyHostId: 8 })];

  it('gives a host the global ones and its own', () => {
    expect(exclusionsFor(all, 7).map((r) => r.id)).toEqual([1, 2]);
  });

  it('gives the global WAF and a new host only the global ones', () => {
    expect(exclusionsFor(all, null).map((r) => r.id)).toEqual([1]);
  });

  it('gives a host overriding the global WAF only its own', () => {
    expect(exclusionsFor(all, 7, true).map((r) => r.id)).toEqual([2]);
  });
});

describe('exclusionDirectives', () => {
  it('skips a stored row that would inject SecLang, keeping the valid ones', () => {
    const { rules, removeIds } = exclusionDirectives([
      rule({ id: 1, path: '/x" "id:1,phase:1,deny"' }),
      rule({ id: 2, target: 'ARGS:a;REQUEST_HEADERS' }),
      rule({ id: 3, target: 'ARGS:a",deny,"' }),
      rule({ id: 4, path: '/x%{tx.0}' }),
      rule({ id: 5, ruleId: 949110 }),
      rule({ id: 6, path: '/a%b' }),
    ]);
    expect(removeIds).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('"@streq /a%b"');
  });

  it('removes an unscoped rule at load time', () => {
    expect(exclusionDirectives([rule({})])).toEqual({ removeIds: [942100], rules: [] });
  });

  it('narrows to a variable with a runtime ctl', () => {
    const { rules, removeIds } = exclusionDirectives([rule({ target: 'ARGS:content' })]);
    expect(removeIds).toEqual([]);
    expect(rules).toEqual([
      `SecAction "id:${WAF_EXCLUSION_RULE_ID_BASE + 1},phase:1,pass,t:none,nolog,ctl:ruleRemoveTargetById=942100;ARGS:content"`,
    ]);
  });

  it('matches an exact path or a prefix on the normalised path', () => {
    const { rules } = exclusionDirectives([
      rule({ id: 4, path: '/upload' }),
      rule({ id: 5, path: '/api/*', target: 'ARGS:q' }),
    ]);
    expect(rules[0]).toBe(
      `SecRule REQUEST_FILENAME "@streq /upload" "id:${WAF_EXCLUSION_RULE_ID_BASE + 4},phase:1,pass,t:none,t:normalisePath,nolog,ctl:ruleRemoveById=942100"`,
    );
    expect(rules[1]).toContain('"@beginsWith /api/"');
    expect(rules[1]).toContain('ctl:ruleRemoveTargetById=942100;ARGS:q');
  });

  it('never emits a protected rule, even from a stored row', () => {
    expect(exclusionDirectives([rule({ ruleId: 949110 })])).toEqual({ removeIds: [], rules: [] });
  });
});

describe('buildWafHandler with exclusions', () => {
  const base: WafSettings = {
    enabled: true,
    mode: 'On',
    load_owasp_crs: true,
    custom_directives: '',
  };

  it('places ctl exclusions before the CRS rules and removals after them', () => {
    const directives = String(
      buildWafHandler({
        ...base,
        excluded_rule_ids: [920350],
        exclusions: [rule({ id: 1 }), rule({ id: 2, ruleId: 941100, path: '/x' })],
      }).directives,
    );
    const ctl = directives.indexOf('ctl:ruleRemoveById=941100');
    const crs = directives.indexOf('Include @owasp_crs/*.conf');
    const removal = directives.indexOf('SecRuleRemoveById 920350 942100');
    expect(ctl).toBeGreaterThan(0);
    expect(ctl).toBeLessThan(crs);
    expect(removal).toBeGreaterThan(crs);
  });

  it('emits exactly what it did before when there are no exclusions', () => {
    expect(buildWafHandler({ ...base, exclusions: [] })).toEqual(buildWafHandler(base));
  });
});
