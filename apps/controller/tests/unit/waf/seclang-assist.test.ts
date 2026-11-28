import { describe, expect, it } from 'bun:test';
import { seclangCompletions, seclangTermAt } from '@/src/lib/waf/seclang-assist';
import {
  ACTION_VALUES,
  actionSpec,
  DIRECTIVE_VALUES,
  OPERATOR_FAMILIES,
  referenceKey,
  SECLANG_OPERATORS,
  SECLANG_TERMS,
  SECLANG_TRANSFORMATIONS,
} from '@/src/lib/waf/seclang-reference';
import messages from '../../../messages/en.json';
import { TRANSFORMATIONS } from '@/src/lib/waf/seclang';

/** Completions with the caret at the last `|`. */
function at(source: string) {
  const caret = source.lastIndexOf('|');
  const text = source.slice(0, caret) + source.slice(caret + 1);
  const result = seclangCompletions(text, caret);
  return result && { ...result, labels: result.items.map((item) => item.label) };
}

describe('seclangCompletions', () => {
  it('offers directives at the start of a line', () => {
    const result = at('SecR|');
    expect(result?.labels.slice(0, 2)).toEqual(['SecRule', 'SecRuleRemoveById']);
    expect(result?.from).toBe(0);
    expect(result?.items[0].insert).toBe('SecRule ');
  });

  it('offers variables, after a pipe and a prefix too', () => {
    expect(at('SecRule REQUEST_U|')?.labels).toContain('REQUEST_URI');
    expect(at('SecRule ARGS|!REQUEST_CO|')?.labels[0]).toBe('REQUEST_COOKIES');
    expect(at('SecRule |')?.labels.length).toBeGreaterThan(10);
  });

  it('offers header names after REQUEST_HEADERS:', () => {
    expect(at('SecRule REQUEST_HEADERS:User|')?.labels).toEqual(['User-Agent']);
  });

  it('offers operators after @, and nothing in the argument', () => {
    expect(at('SecRule ARGS "@cont|')?.labels).toEqual(['contains']);
    expect(at('SecRule ARGS "!@begins|')?.labels).toEqual(['beginsWith']);
    expect(at('SecRule ARGS "@contains fo|')).toBeNull();
  });

  it('offers actions, and values for the actions that take fixed ones', () => {
    expect(at('SecRule ARGS "@rx a" "id:1,de|')?.labels).toEqual(['deny']);
    expect(at('SecRule ARGS "@rx a" "id:1,ms|')?.items[0].insert).toBe('msg:');
    expect(at('SecRule ARGS "@rx a" "t:lower|')?.labels).toEqual(['lowercase']);
    expect(at('SecAction "phase:|')?.labels).toEqual(['1', '2', '3', '4', '5']);
    expect(at('SecRule ARGS "@rx a" "severity:CRI|')?.labels).toEqual(['CRITICAL']);
    expect(at('SecAction "ctl:ruleRemoveBy|')?.labels[0]).toBe('ruleRemoveById=');
  });

  it('stays quiet inside a quoted value and after a comment', () => {
    expect(at('SecAction "msg:\'deny|')).toBeNull();
    expect(at('# SecR|')).toBeNull();
  });

  it('follows a rule over line continuations', () => {
    expect(at('SecRule ARGS "@rx a" \\\n    "id:1,\\\n    blo|')?.labels).toEqual(['block']);
  });

  it('offers values for engine settings', () => {
    expect(at('SecRuleEngine D|')?.labels).toEqual(['DetectionOnly']);
  });

  it('offers nothing for an exact lone match', () => {
    expect(at('SecRule ARGS "@rx a" "deny|')).toBeNull();
  });
});

describe('seclangTermAt', () => {
  const text = 'SecRule REQUEST_HEADERS:User-Agent "@contains bot" "id:1,deny,t:lowercase"';
  const term = (word: string, nth = 0) => {
    let index = -1;
    for (let i = 0; i <= nth; i++) index = text.indexOf(word, index + 1);
    return seclangTermAt(text, index + 1);
  };

  it('names each kind of term', () => {
    expect(term('SecRule')).toMatchObject({ kind: 'directives', name: 'SecRule' });
    expect(term('REQUEST_HEADERS')).toMatchObject({ kind: 'variables', name: 'REQUEST_HEADERS' });
    expect(term('contains')).toMatchObject({ kind: 'operators', name: 'contains' });
    expect(term('deny')).toMatchObject({ kind: 'actions', name: 'deny' });
    expect(term('lowercase')).toMatchObject({ kind: 'transformations', name: 'lowercase' });
  });

  it('says nothing about free text', () => {
    expect(term('bot')).toBeNull();
    expect(term('User')).toBeNull();
  });
});

describe('the reference', () => {
  it('puts every operator in a family', () => {
    expect(SECLANG_OPERATORS.filter((op) => !OPERATOR_FAMILIES[op])).toEqual([]);
  });

  it('spells every transformation Coraza knows', () => {
    expect(new Set(SECLANG_TRANSFORMATIONS.map((t) => t.toLowerCase()))).toEqual(TRANSFORMATIONS);
  });
});

describe('seclang.reference messages', () => {
  const reference = messages.seclang.reference as Record<string, Record<string, string>>;

  it('describes every term an editor offers, and nothing else', () => {
    for (const [kind, terms] of Object.entries(SECLANG_TERMS)) {
      const keys = terms.map(referenceKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.filter((key) => !reference[kind]?.[key])).toEqual([]);
      expect(Object.keys(reference[kind] ?? {}).filter((key) => !keys.includes(key))).toEqual([]);
    }
  });
});

describe('input-keyed lookups', () => {
  it('finds nothing under an Object.prototype name', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(actionSpec(name)).toBeUndefined();
      expect(ACTION_VALUES[name.toLowerCase()]).toBeUndefined();
      expect(DIRECTIVE_VALUES[name.toLowerCase()]).toBeUndefined();
      expect(OPERATOR_FAMILIES[name]).toBeUndefined();
    }
    expect(seclangCompletions('SecAction "id:1,constructor:', 28)).toBeNull();
    expect(seclangCompletions('constructor ', 12)).toBeNull();
  });
});
