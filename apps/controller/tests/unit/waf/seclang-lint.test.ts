/**
 * src/lib/waf/seclang.ts. Every error case here is one Coraza v3.7 refuses at config load; the valid
 * cases are the shapes the CRS itself uses, since an error on one of those blocks a save Caddy
 * would have taken.
 */
import { describe, expect, it } from 'bun:test';
import {
  findUnsupportedRegex,
  lintSeclang,
  seclangDirectives,
  seclangErrors,
} from '../../../src/lib/waf/seclang';
import { WAF_QUICK_TEMPLATES } from '../../../src/lib/waf/templates';

const codes = (text: string, options?: Parameters<typeof lintSeclang>[1]) =>
  lintSeclang(text, options).map((issue) => `${issue.severity}:${issue.code}`);

describe('seclangDirectives', () => {
  it('reports where a continued directive starts', () => {
    const directives = seclangDirectives(
      '# c\nSecRule ARGS "@rx a" \\\n  "id:1,deny"\nSecMarker END',
    );
    expect(directives.map((d) => [d.text, d.start])).toEqual([
      ['', 0],
      ['SecRule ARGS "@rx a" "id:1,deny"', 1],
      ['SecMarker END', 3],
    ]);
  });
});

describe('lintSeclang - accepted', () => {
  it.each([
    `SecRule REQUEST_URI "@beginsWith /api/" "id:9001,phase:1,pass,nolog,ctl:ruleRemoveById=942100"`,
    `SecRule ARGS|!ARGS:foo|&REQUEST_HEADERS:Host "@rx ^a|b$" "id:2,phase:2,block,t:none,t:lowercase"`,
    `SecRule ARGS:/^id_[0-9]+|x$/ "@gt 5" "id:3,deny"`,
    `SecRule REQUEST_HEADERS:'User-Agent' "bad" "id:4,deny"`,
    `SecRule ARGS "!@contains safe" "id:5,pass,msg:'a, b: c',setvar:'tx.score=+%{tx.critical}'"`,
    `SecAction "id:6,phase:1,nolog,pass,setvar:tx.x=1"`,
    `SecRule REQUEST_URI "@streq /" "id:7,phase:1,allow:request"`,
    `SecDefaultAction "phase:1,log,auditlog,pass"\nSecAction "id:8,pass"`,
    `SecRule ARGS "@rx a" "id:9,chain,deny"\n  SecRule ARGS "@rx b" "t:none"\n  SecRule ARGS "@rx c"`,
    `SecRule ARGS "@rx [(?=]\\\\1" "id:10,deny,severity:CRITICAL,maturity:9,status:403"`,
    `SecMarker END-OF-RULES`,
  ])('%s', (text) => {
    expect(seclangErrors(text)).toEqual([]);
  });

  it('passes every quick template', () => {
    for (const template of WAF_QUICK_TEMPLATES) expect(lintSeclang(template.snippet)).toEqual([]);
  });

  it('ignores directives it does not read, and comments', () => {
    expect(
      lintSeclang('# SecRule nonsense\nSecRequestBodyLimit 1048576\nSecRuleEngine On'),
    ).toEqual([]);
  });
});

describe('lintSeclang - refused by Coraza', () => {
  it.each([
    ['SecRule ARGS', 'seclangRuleFormat'],
    ['SecRule ARGS @rx "id:1"', 'seclangRuleFormat'],
    ['SecRule ARGS "@rx a', 'seclangRuleFormat'],
    ['SecRule ARGS "@rx a" id:1', 'seclangRuleFormat'],
    ['SecRule ARG "@rx a" "id:1,deny"', 'seclangUnknownVariable'],
    ['SecRule REQUEST_URI:foo "@rx a" "id:1,deny"', 'seclangNotSelectable'],
    ['SecRule ARGS "@contain a" "id:1,deny"', 'seclangUnknownOperator'],
    ['SecRule ARGS "@RX a" "id:1,deny"', 'seclangUnknownOperator'],
    ['SecRule ARGS "@rx (?<!a)b" "id:1,deny"', 'seclangUnsupportedRegex'],
    ['SecRule ARGS "(a)\\1" "id:1,deny"', 'seclangUnsupportedRegex'],
    ['SecRule ARGS "@rx a++" "id:1,deny"', 'seclangUnsupportedRegex'],
    ['SecRule ARGS "@rx a" "id:1,denied"', 'seclangUnknownAction'],
    ['SecRule ARGS "@rx a" "id:1,deny:403"', 'seclangActionTakesNoArgument'],
    ['SecRule ARGS "@rx a" "id:1,deny,msg"', 'seclangActionNeedsArgument'],
    ['SecRule ARGS "@rx a" "id:0,deny"', 'seclangInvalidId'],
    ['SecRule ARGS "@rx a" "id:abc,deny"', 'seclangInvalidId'],
    ['SecRule ARGS "@rx a" "id:1,phase:6,deny"', 'seclangInvalidActionArgument'],
    ['SecRule ARGS "@rx a" "id:1,allow:everything"', 'seclangInvalidActionArgument'],
    ['SecRule ARGS "@rx a" "id:1,deny,severity:loud"', 'seclangInvalidActionArgument'],
    ['SecRule ARGS "@rx a" "id:1,skip:0"', 'seclangInvalidActionArgument'],
    ['SecRule ARGS "@rx a" "id:1,deny,t:lowercaseAll"', 'seclangUnknownTransformation'],
    ['SecRule ARGS "@rx a" "id:1,pass,setvar:ip.score=1"', 'seclangSetvarNotTx'],
    ['SecAction ""', 'seclangEmptyDirective'],
    ['SecMarker', 'seclangEmptyDirective'],
  ])('%s', (text, code) => {
    expect(seclangErrors(text).map((issue) => issue.code)).toContain(code as never);
  });

  it('names the line of a duplicate id and the first use', () => {
    const issues = seclangErrors('SecAction "id:5,pass"\n\nSecAction "id:5,pass"');
    expect(issues).toEqual([
      { line: 3, severity: 'error', code: 'seclangDuplicateId', params: { id: '5', first: '1' } },
    ]);
  });

  it('refuses a disruptive action on a chain member', () => {
    expect(codes('SecRule ARGS "@rx a" "id:1,chain,deny"\nSecRule ARGS "@rx b" "deny"')).toEqual([
      'error:seclangChainDisruptive',
    ]);
  });

  it('does not count a chain member without an id as missing one', () => {
    expect(codes('SecRule ARGS "@rx a" "id:1,chain,deny"\nSecRule ARGS "@rx b" "t:none"')).toEqual(
      [],
    );
  });
});

describe('lintSeclang - SecDefaultAction', () => {
  it('is an error only when a rule follows it', () => {
    expect(codes('SecDefaultAction "log,pass"\nSecAction "id:1,pass"')).toEqual([
      'error:seclangDefaultActionNeedsPhase',
    ]);
    expect(codes('SecDefaultAction "log,pass"')).toEqual([
      'warning:seclangDefaultActionNeedsPhase',
    ]);
  });

  it('refuses metadata, transformations, a missing disruptive action and a repeated phase', () => {
    expect(
      codes(
        'SecDefaultAction "phase:2,log,id:4,t:none"\nSecDefaultAction "phase:2,pass"\nSecAction "id:1,pass"',
      ),
    ).toEqual([
      'error:seclangDefaultActionTransformation',
      'error:seclangDefaultActionMetadata',
      'error:seclangDefaultActionNeedsDisruptive',
      'error:seclangDefaultActionDuplicatePhase',
    ]);
  });

  it('warns about a phase the CRS already defaults, with the CRS on', () => {
    expect(codes('SecDefaultAction "phase:1,pass"', { crsLoaded: true })).toEqual([
      'warning:seclangDefaultActionDuplicatePhase',
    ]);
    expect(codes('SecDefaultAction "phase:1,pass"')).toEqual([]);
  });
});

describe('lintSeclang - warnings', () => {
  it('warns about a missing id, a CRS-range id, a dangling chain and an unclosed quote', () => {
    expect(codes('SecRule ARGS "@rx a" "deny"')).toEqual(['warning:seclangMissingId']);
    expect(codes('SecAction "id:942100,pass"', { crsLoaded: true })).toEqual([
      'warning:seclangCrsIdRange',
    ]);
    expect(codes('SecAction "id:942100,pass"')).toEqual([]);
    expect(codes('SecRule ARGS "@rx a" "id:1,chain,deny"')).toEqual([
      'warning:seclangDanglingChain',
    ]);
    expect(codes(`SecAction "id:1,pass,msg:'open"`)).toEqual([
      'warning:seclangUnclosedActionQuote',
    ]);
  });

  it('numbers lines as the editor does, CRLF included', () => {
    expect(lintSeclang('\r\n\r\nSecRule ARGS "@rx a" "deny"')[0].line).toBe(3);
  });
});

describe('findUnsupportedRegex', () => {
  it.each([
    ['(?=a)', '(?='],
    ['(?!a)', '(?!'],
    ['(?<=a)', '(?<='],
    ['(?>a)', '(?>'],
    ['a\\Z', '\\Z'],
    ['a{2}+', '}+'],
    ['(?<name>a)\\k<name>', '\\k<'],
  ])('%s', (pattern, construct) => {
    expect(findUnsupportedRegex(pattern)).toBe(construct);
  });

  it.each(['[(?=)]', '\\\\1', '(?i)a+?', '(?<name>a)', '[]a]+', '[^]a]*', 'a\\z'])(
    'accepts %s',
    (pattern) => {
      expect(findUnsupportedRegex(pattern)).toBeNull();
    },
  );
});
