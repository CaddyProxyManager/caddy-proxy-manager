import { describe, expect, it } from 'bun:test';
import {
  blankRule,
  entryLineSpans,
  formatBlock,
  nextRuleId,
  parseSeclang,
  serializeSeclang,
  type SeclangEntry,
} from '@/src/lib/waf/seclang-model';
import { lintSeclang } from '@/src/lib/waf/seclang';

const SAMPLE = [
  '# Block the admin area',
  '# from everyone',
  'SecRule REQUEST_URI "@beginsWith /admin" "id:9001,phase:1,deny,status:403,log,msg:\'No admin\'"',
  '',
  '',
  'SecRule REQUEST_METHOD "@streq POST" \\',
  '    "id:9002,phase:2,chain,deny"',
  '    SecRule &ARGS:token|!ARGS:id "@eq 0" "t:none,t:lowercase"',
  'SecAction "id:9003,phase:1,pass,nolog,setvar:tx.score=0"',
  'SecRuleEngine DetectionOnly',
  'SecRule ARGS "@rx (" "id:9004',
].join('\n');

const rebuild = (entries: SeclangEntry[]) =>
  entries.map((entry) => ({ ...entry, source: formatBlock(entry.block) }));

describe('parseSeclang', () => {
  it('gives the text back unchanged', () => {
    for (const text of [SAMPLE, '', '\n', 'SecMarker END\n\n', '\r\nSecMarker A\r\n']) {
      expect(serializeSeclang(parseSeclang(text))).toBe(text.replace(/\r\n?/g, '\n'));
    }
  });

  it('reads comments, chains, actions and other directives as blocks', () => {
    const kinds = parseSeclang(SAMPLE).map((entry) => entry.block.kind);
    expect(kinds).toEqual(['comment', 'rule', 'rule', 'action', 'directive', 'raw']);
  });

  it('merges a comment run and strips the hashes', () => {
    const [comment] = parseSeclang(SAMPLE);
    expect(comment.block).toEqual({ kind: 'comment', text: 'Block the admin area\nfrom everyone' });
  });

  it('splits variables, operator and actions, with the chain implied', () => {
    const chained = parseSeclang(SAMPLE)[2];
    expect(chained.gapBefore).toBe(2);
    if (chained.block.kind !== 'rule') throw new Error('not a rule');
    const [first, second] = chained.block.conditions;
    expect(first.operator).toEqual({ isNegated: false, name: 'streq', argument: 'POST' });
    expect(first.actions.map((a) => a.name)).toEqual(['id', 'phase', 'deny']);
    expect(second.variables).toEqual([
      { name: 'ARGS', key: 'token', isExcluded: false, isCount: true },
      { name: 'ARGS', key: 'id', isExcluded: true, isCount: false },
    ]);
    expect(second.actions).toEqual([
      { name: 't', value: 'none' },
      { name: 't', value: 'lowercase' },
    ]);
  });

  it('reads an operator without @ as @rx', () => {
    const [entry] = parseSeclang('SecRule ARGS "foo|bar" "id:1,deny"');
    if (entry.block.kind !== 'rule') throw new Error('not a rule');
    expect(entry.block.conditions[0].operator).toEqual({
      isNegated: false,
      name: 'rx',
      argument: 'foo|bar',
    });
  });

  it('keeps a regex key with a pipe in it whole', () => {
    const [entry] = parseSeclang('SecRule ARGS:/^a|b$/|ARGS_NAMES "@rx x" "id:1"');
    if (entry.block.kind !== 'rule') throw new Error('not a rule');
    expect(entry.block.conditions[0].variables.map((v) => v.key)).toEqual(['/^a|b$/', '']);
  });

  it('leaves a chain broken by a comment as raw text', () => {
    const text = 'SecRule ARGS "@rx a" "id:1,chain"\n# note\nSecRule ARGS "@rx b"';
    expect(parseSeclang(text)[0].block.kind).toBe('raw');
    expect(serializeSeclang(parseSeclang(text))).toBe(text);
  });
});

describe('formatBlock', () => {
  it('leaves off a trailing backslash rather than swallow the actions after it', () => {
    const text = formatBlock({
      kind: 'action',
      actions: [
        { name: 'id', value: '9001' },
        { name: 'msg', value: 'oops\\' },
        { name: 'deny', value: '' },
      ],
    });
    expect(text).toBe('SecAction "id:9001,msg:oops,deny"');
    const [entry] = parseSeclang(text);
    expect(entry.block.kind === 'action' && entry.block.actions.map((a) => a.name)).toEqual([
      'id',
      'msg',
      'deny',
    ]);
  });

  it('writes a rule Coraza reads back the same', () => {
    const entries = rebuild(parseSeclang(SAMPLE));
    const text = serializeSeclang(entries);
    const reparsed = parseSeclang(text).map((entry) => entry.block);
    expect(reparsed).toEqual(entries.map((entry) => entry.block));
    // The last entry is the deliberately broken rule.
    const valid = serializeSeclang(entries.slice(0, -1));
    expect(lintSeclang(valid).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('quotes values Coraza would otherwise split, escaping single quotes', () => {
    const block = {
      kind: 'action' as const,
      actions: [
        { name: 'id', value: '7' },
        { name: 'msg', value: "it's, bad" },
      ],
    };
    expect(formatBlock(block)).toBe("SecAction \"id:7,msg:'it\\'s, bad'\"");
  });

  it('escapes double quotes in an operator argument', () => {
    const block = {
      kind: 'rule' as const,
      conditions: [
        {
          variables: [{ name: 'ARGS', key: '', isExcluded: false, isCount: false }],
          operator: { isNegated: true, name: 'contains', argument: 'a"b' },
          actions: [{ name: 'id', value: '1' }],
        },
      ],
    };
    const text = formatBlock(block);
    expect(text).toBe('SecRule ARGS "!@contains a\\"b" "id:1"');
    expect(parseSeclang(text)[0].block).toEqual(block);
  });

  it('wraps a long action list CRS-style', () => {
    const rule = blankRule(9100);
    if (rule.kind !== 'rule') throw new Error('not a rule');
    rule.conditions[0].actions.push({ name: 'msg', value: 'x'.repeat(80) });
    const text = formatBlock(rule);
    expect(text.split('\n').length).toBeGreaterThan(2);
    expect(parseSeclang(text)[0].block).toEqual(rule);
  });
});

describe('line spans and ids', () => {
  it('maps each entry to the lines it occupies', () => {
    const spans = entryLineSpans(parseSeclang(SAMPLE));
    expect(spans.slice(0, 3)).toEqual([
      { start: 1, length: 2 },
      { start: 3, length: 1 },
      { start: 6, length: 3 },
    ]);
  });

  it('finds the next id past the highest in use', () => {
    expect(nextRuleId(parseSeclang(SAMPLE), 9000)).toBe(9004);
    expect(nextRuleId([], 9000)).toBe(9000);
  });
});
