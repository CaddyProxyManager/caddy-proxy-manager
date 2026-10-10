/**
 * With the strict setting the custom-directive allowlist is the WAF's security boundary: a line
 * that reads the container's files, runs a program, changes Caddy's environment or turns the
 * engine off must never reach Coraza, however it is spelt. Without it those lines are sent and
 * flagged instead. Either way a line Coraza refuses must not take every host's config down.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  buildWafHandler,
  type CustomDirectiveFilterOptions,
  customDirectivesError as customDirectivesErrorWith,
  directivePolicyIssues,
  droppedWafDirectiveDetails,
  filterCustomDirectives as filterCustomDirectivesWith,
  findInvalidBodyLimitDirective,
  GLOBAL_WAF_SOURCE,
  listDroppedWafDirectives,
  type PreviousCustomDirectives,
  resolveEffectiveWaf,
  riskyDirectiveWarnings,
  wafDirectiveSource,
} from '../../../src/lib/waf/caddy';

// Strict throughout: these tests are the allowlist's. The lenient mode has its own block below.
const baseWaf = {
  enabled: true,
  mode: 'On' as const,
  load_owasp_crs: false,
  custom_directives: '',
  strict_directives: true,
};

const strict = (options: CustomDirectiveFilterOptions = {}) => ({
  strictDirectives: true,
  ...options,
});

const filterCustomDirectives = (raw: string, options?: CustomDirectiveFilterOptions) =>
  filterCustomDirectivesWith(raw, strict(options));

const customDirectivesError = (
  raw: string,
  options?: CustomDirectiveFilterOptions,
  previous?: PreviousCustomDirectives,
  subject?: Parameters<typeof customDirectivesErrorWith>[3],
) =>
  customDirectivesErrorWith(
    raw,
    strict(options),
    previous && { ...previous, options: strict(previous.options) },
    subject,
  );

const reasons = (raw: string, crsLoaded?: boolean) =>
  filterCustomDirectives(raw, { crsLoaded }).dropped.map((entry) => entry.reason);

describe('filterCustomDirectives - operators that read files or run programs', () => {
  it('drops each of them, negated or in any case', () => {
    const lines = [
      'SecRule FILES_TMPNAMES "@inspectFile /usr/local/bin/scan" "id:9101,deny"',
      'SecRule ARGS "@pmFromFile /etc/hosts" "id:9102,deny"',
      'SecRule ARGS "@pmf words.txt" "id:9103,deny"',
      'SecRule REMOTE_ADDR "!@ipMatchFromFile /data/ips.txt" "id:9104,deny"',
      'SecRule REMOTE_ADDR "@ipMatchF ips.txt" "id:9105,deny"',
      'SecRule REQUEST_BODY "@validateSchema /data/schema.json" "id:9106,deny"',
      'SecRule ARGS "@INSPECTFILE /bin/x" "id:9107,deny"',
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'));
    expect(kept).toEqual([]);
    expect(dropped.map((entry) => entry.reason)).toEqual(
      lines.map(() => 'wafDirectiveDroppedFileOperator'),
    );
    expect(droppedWafDirectiveDetails(dropped)[0]).toContain(
      '@inspectFile reads files or runs programs inside the container',
    );
  });

  it('keeps operators that only look like them', () => {
    const line = 'SecRule ARGS "@pm pmfoo inspectFile" "id:9108,deny"';
    expect(filterCustomDirectives(line)).toEqual({ kept: [line], dropped: [] });
  });
});

describe('filterCustomDirectives - setenv and ctl:ruleEngine', () => {
  it('drops setenv, which changes the Caddy process environment', () => {
    const lines = [
      'SecAction "id:9201,phase:1,pass,nolog,setenv:GODEBUG=x509sha1=1"',
      'SecRule ARGS "@contains x" "id:9202,pass, SETENV :FOO=%{REQUEST_HEADERS.x}"',
      'SecDefaultAction "phase:1,log,pass,setenv:FOO=1"',
    ];
    expect(reasons(lines.join('\n'))).toEqual(lines.map(() => 'wafDirectiveDroppedSetenv'));
  });

  // Coraza trims keys and values with Go's TrimSpace (U+0085 included) and strips a pair of quotes.
  it('drops them however Coraza lets them be spaced or quoted', () => {
    const lines = [
      'SecAction "id:9211,phase:1,pass,nolog,ctl: ruleEngine=Off"',
      'SecAction "id:9212,phase:1,pass,nolog,ctl :ruleEngine=Off"',
      'SecAction "id:9213,phase:1,pass,nolog,ctl:\'ruleEngine=Off\'"',
      'SecAction "id:9214,phase:1,pass,nolog,ctl\u0085:ruleEngine=Off"',
      'SecRule ARGS "@contains x" "id:9215,pass,ctl:\u0085ruleEngine=DetectionOnly"',
      'SecAction "id:9216,phase:1,pass,nolog,setenv\u0085:GODEBUG=x509sha1=1"',
      'SecAction "id:9217,phase:1,pass,nolog,\u0085setenv:GODEBUG=x509sha1=1"',
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'));
    expect(kept).toEqual([]);
    expect(dropped.map((entry) => entry.line)).toEqual(lines);
    for (const { reason } of dropped) {
      expect(['wafDirectiveDroppedCtlRuleEngine', 'wafDirectiveDroppedSetenv']).toContain(reason);
    }
  });

  it('keeps other ctl actions', () => {
    const line =
      'SecRule REQUEST_URI "@beginsWith /api" "id:9218,phase:1,pass,nolog,ctl:ruleRemoveById=941100"';
    expect(filterCustomDirectives(line)).toEqual({ kept: [line], dropped: [] });
  });
});

describe('filterCustomDirectives - what Coraza cannot parse', () => {
  it('drops a rule directive Coraza would refuse, and with it the whole config', () => {
    const lines = [
      'SecRule\tARGS "@contains x" "id:9221,deny"',
      'SecRule ARGS "@contains x" \'id:9222,deny\'',
      'SecRule ARGS "@contains x" "id:9223,deny" trailing',
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'));
    expect(kept).toEqual([]);
    expect(dropped).toEqual(
      lines.map((line) => ({ line, reason: 'wafDirectiveDroppedUnparseable' })),
    );
  });

  it('keeps an unfinished directive out of the generated handler', () => {
    const standalone = 'SecRule ARGS "@contains x" "id:9231,deny"';
    const unfinished = 'SecAction "id:9232,phase:1,pass,nolog" \\';
    expect(filterCustomDirectives(`${standalone}\n${unfinished}`)).toEqual({
      kept: [standalone],
      dropped: [{ line: unfinished, reason: 'wafDirectiveDroppedUnterminated' }],
    });
    const handler = buildWafHandler({
      ...baseWaf,
      custom_directives: unfinished,
      request_body_limit: 1_048_576,
    });
    expect(handler.directives).not.toContain('id:9232');
  });

  it('trims lines the way Coraza does, U+0085 included', () => {
    const line = 'SecRequestBodyLimit 1048576\u0085';
    expect(filterCustomDirectives(line)).toEqual({ kept: [line], dropped: [] });
    expect(findInvalidBodyLimitDirective('SecRequestBodyLimit 10737418240\u0085')).toBe(
      'SecRequestBodyLimit 10737418240',
    );
  });
});

// A chain is one rule to Coraza: dropping part of it hands Coraza a different rule, or a child with
// a disruptive action, which fails the whole config.
describe('filterCustomDirectives - chained rules', () => {
  const standalone = 'SecRule ARGS "@contains x" "id:101,deny"';

  it('drops the whole chain when a child is dropped, keeping the next rule standalone', () => {
    const starter = 'SecRule REQUEST_URI "@beginsWith /admin" "id:100,deny,chain"';
    const child = 'SecRule REMOTE_ADDR "!@ipMatchFromFile allow.txt"';
    const { kept, dropped } = filterCustomDirectives([starter, child, standalone].join('\n'));
    expect(kept).toEqual([standalone]);
    expect(dropped).toEqual([
      { line: starter, reason: 'wafDirectiveDroppedChainPart', params: { line: child } },
      {
        line: child,
        reason: 'wafDirectiveDroppedFileOperator',
        params: { name: 'ipMatchFromFile' },
      },
    ]);
    expect(droppedWafDirectiveDetails(dropped)[0]).toContain(
      `part of a chained rule whose directive "${child}" is dropped`,
    );
  });

  it('drops the children when the starter is dropped', () => {
    const starter = 'SecRule ARGS "@pmFromFile /etc/hosts" "id:110,deny,chain"';
    const child = 'SecRule REMOTE_ADDR "@ipMatch 10.0.0.0/8"';
    const { kept, dropped } = filterCustomDirectives([starter, child, standalone].join('\n'));
    expect(kept).toEqual([standalone]);
    expect(dropped.map((entry) => entry.line)).toEqual([starter, child]);
  });

  it('drops every link of a longer chain across comments', () => {
    const lines = [
      'SecRule REQUEST_URI "@beginsWith /api" "id:120,phase:1,deny,chain"',
      '# the middle link reads a file',
      'SecRule REQUEST_HEADERS:User-Agent "@pmf agents.txt" "chain"',
      'SecRule REMOTE_ADDR "!@ipMatch 10.0.0.0/8"',
      standalone,
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'));
    expect(kept).toEqual(['# the middle link reads a file', standalone]);
    expect(dropped.map((entry) => entry.line)).toEqual([lines[0], lines[2], lines[3]]);
  });

  it('leaves a chain alone when none of it is dropped', () => {
    const lines = [
      'SecRule REQUEST_URI "@beginsWith /admin" "id:130,phase:1,deny,msg:\'no, chain here\',chain"',
      'SecRule REMOTE_ADDR "!@ipMatch 10.0.0.0/8"',
      'SecRule ARGS "@pmFromFile /etc/hosts" "id:131,deny"',
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'));
    expect(kept).toEqual([lines[0], lines[1]]);
    expect(dropped.map((entry) => entry.line)).toEqual([lines[2]]);
  });

  it('does not take chain inside a quoted value or the operator for the chain action', () => {
    const lines = [
      'SecRule ARGS "@contains chain" "id:140,deny,msg:\'chain\'"',
      'SecRule ARGS "@pmFromFile /etc/hosts" "id:141,deny"',
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'));
    expect(kept).toEqual([lines[0]]);
    expect(dropped.map((entry) => entry.line)).toEqual([lines[1]]);
  });

  it('ends a pending chain at SecMarker', () => {
    const lines = [
      'SecRule ARGS "@pmFromFile /etc/hosts" "id:150,deny,chain"',
      'SecMarker END_CHECKS',
      standalone,
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'));
    expect(kept).toEqual([lines[1], standalone]);
    expect(dropped.map((entry) => entry.line)).toEqual([lines[0]]);
  });

  it('drops the child of a dropped multi-line starter', () => {
    const lines = [
      'SecRule REQUEST_URI "@beginsWith /admin" \\',
      '    "id:170,deny,setenv:x=1,chain"',
      'SecRule REMOTE_ADDR "!@ipMatch 10.0.0.0/8"',
      standalone,
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'));
    expect(kept).toEqual([standalone]);
    expect(dropped.map((entry) => entry.reason)).toEqual([
      'wafDirectiveDroppedSetenv',
      'wafDirectiveDroppedChainPart',
    ]);
  });

  it('keeps no partial chain in the generated handler', () => {
    const directives = buildWafHandler({
      ...baseWaf,
      custom_directives: [
        'SecRule REQUEST_URI "@beginsWith /admin" "id:100,deny,chain"',
        'SecRule REMOTE_ADDR "!@ipMatchFromFile allow.txt"',
        standalone,
      ].join('\n'),
    }).directives as string;
    expect(directives).not.toContain('id:100');
    expect(directives).toContain(standalone);
  });
});

// Coraza refuses a rule id already in its rule group, and Caddy then the whole config.
describe('filterCustomDirectives - duplicate rule ids', () => {
  it("drops a later rule reusing a kept rule's id, with its chain", () => {
    const first = 'SecRule ARGS "@contains a" "id:9701,deny"';
    const again = 'SecAction "id:9701,phase:1,pass,nolog"';
    const starter = `SecRule REQUEST_URI "@beginsWith /x" "id:'09701',deny,chain"`;
    const child = 'SecRule ARGS "@contains b" "t:none"';
    const next = 'SecRule ARGS "@contains c" "id:9702,deny"';
    const { kept, dropped } = filterCustomDirectives(
      [first, again, starter, child, next].join('\n'),
    );
    expect(kept).toEqual([first, next]);
    expect(dropped).toEqual([
      { line: again, reason: 'wafDirectiveDroppedDuplicateId', params: { id: '9701' } },
      { line: starter, reason: 'wafDirectiveDroppedDuplicateId', params: { id: '9701' } },
      { line: child, reason: 'wafDirectiveDroppedChainPart', params: { line: starter } },
    ]);
  });

  it('lets a rule reuse the id of one dropped for another reason', () => {
    const droppedFirst = 'SecRule ARGS "@contains a" "id:9711,deny,setenv:x=1"';
    const reuse = 'SecRule ARGS "@contains b" "id:9711,deny"';
    expect(filterCustomDirectives(`${droppedFirst}\n${reuse}`).kept).toEqual([reuse]);
  });

  it('checks a merge-mode host against the global lines it follows, reporting only its own', () => {
    const rule = 'SecRule REQUEST_URI "@beginsWith /api/" "id:9001,phase:1,pass,nolog"';
    expect(reasons(rule)).toEqual([]);
    expect(
      filterCustomDirectives(rule, { precedingDirectives: rule }).dropped.map((d) => d.reason),
    ).toEqual(['wafDirectiveDroppedDuplicateId']);
    expect(
      filterCustomDirectives(rule, {
        precedingDirectives: `Include /etc/passwd\n${rule.replace('9001', '9101')}`,
      }).dropped,
    ).toEqual([]);
    expect(filterCustomDirectives('', { precedingDirectives: `${rule}\n${rule}` }).dropped).toEqual(
      [],
    );
  });

  it('continues a chain the preceding lines leave open', () => {
    const starter = 'SecRule REQUEST_URI "@beginsWith /admin" "id:9720,phase:2,deny,chain"';
    const child = 'SecRule ARGS "@pmFromFile /etc/x" "t:none"';
    const { kept, dropped } = filterCustomDirectives(child, { precedingDirectives: starter });
    expect(kept).toEqual([]);
    expect(dropped.map((entry) => entry.line)).toEqual([child]);
  });
});

describe('filterCustomDirectives - embedded CRS data files', () => {
  const crsRule =
    'SecRule REQUEST_HEADERS:User-Agent "@pmFromFile @owasp_crs/scanners-user-agents.data" "id:9301,deny"';

  it('keeps the data-file operators reading a file of the embedded CRS', () => {
    const lines = [
      crsRule,
      'SecRule ARGS "@pmf @owasp_crs/unix-shell.data" "id:9302,deny"',
      'SecRule REMOTE_ADDR "!@ipMatchFromFile @owasp_crs/ssrf.data" "id:9303,deny"',
      'SecRule REMOTE_ADDR "@ipMatchF   @owasp_crs/ssrf-no-scheme.data" "id:9304,deny"',
    ];
    for (const crsLoaded of [true, undefined]) {
      expect(filterCustomDirectives(lines.join('\n'), { crsLoaded })).toEqual({
        kept: lines,
        dropped: [],
      });
    }
  });

  it('drops them when the CRS is not loaded', () => {
    expect(filterCustomDirectives(crsRule, { crsLoaded: false }).dropped).toEqual([
      {
        line: crsRule,
        reason: 'wafDirectiveDroppedCrsDataFileNeedsCrs',
        params: { file: '@owasp_crs/scanners-user-agents.data' },
      },
    ]);
  });

  it('drops paths leaving the embedded prefix, and operators that are not data lookups', () => {
    const lines = [
      'SecRule ARGS "@pmFromFile @owasp_crs/../../etc/passwd" "id:9311,deny"',
      'SecRule ARGS "@pmFromFile @owasp_crs/sub/x.data" "id:9312,deny"',
      'SecRule ARGS "@pmFromFile @owasp_crs/..data" "id:9313,deny"',
      'SecRule ARGS "@pmFromFile /srv/@owasp_crs/x.data" "id:9314,deny"',
      'SecRule ARGS "@pmFromFile @owasp_crs/a.data @owasp_crs/b.data" "id:9315,deny"',
      'SecRule FILES_TMPNAMES "@inspectFile @owasp_crs/x.data" "id:9316,deny"',
      'SecRule REQUEST_BODY "@validateSchema @owasp_crs/x.data" "id:9317,deny"',
      'SecRule ARGS "@pmFromFile @owasp_crs/x.data" "id:9318,deny,msg:\'@pmf /etc/hosts\'"',
      'SecRule ARGS "@rx @pmFromFile @owasp_crs/x.data" "id:9319,deny"',
      'SecRule ARGS "@pmFromFile @owasp_crs/x.data" \\',
    ];
    const { kept, dropped } = filterCustomDirectives(lines.join('\n'), { crsLoaded: true });
    expect(kept).toEqual([]);
    expect(dropped).toHaveLength(lines.length);
    for (const { reason } of dropped) {
      expect([
        'wafDirectiveDroppedFileOperator',
        'wafDirectiveDroppedCrsDataFileUnknown',
        'wafDirectiveDroppedUnterminated',
      ]).toContain(reason);
    }
  });

  // Coraza looks operators up case-sensitively, and fails on a data file the rule set lacks.
  it('keeps only the operator spellings Coraza registers', () => {
    for (const operator of ['pmfromfile', 'PMF', 'PmFromFile', 'ipmatchf', 'IPMatchFromFile']) {
      const line = `SecRule ARGS "@${operator} @owasp_crs/unix-shell.data" "id:9321,deny"`;
      expect(reasons(line, true)).toEqual(['wafDirectiveDroppedOperatorCase']);
      expect(customDirectivesError(line, { crsLoaded: true })?.code).toBe('wafDirectivesDropped');
    }
    const { dropped } = filterCustomDirectives(
      'SecRule ARGS "@PMF @owasp_crs/unix-shell.data" "id:9321,deny"',
    );
    expect(droppedWafDirectiveDetails(dropped)[0]).toContain('use @pmf');
  });

  it('keeps only data files the embedded rule set ships', () => {
    for (const file of [
      'unix-shel.data',
      'Unix-Shell.data',
      'unix-shell.conf',
      'REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf.example',
    ]) {
      const line = `SecRule ARGS "@pmFromFile @owasp_crs/${file}" "id:9322,deny"`;
      expect(filterCustomDirectives(line, { crsLoaded: true }).dropped).toEqual([
        {
          line,
          reason: 'wafDirectiveDroppedCrsDataFileUnknown',
          params: { file: `@owasp_crs/${file}` },
        },
      ]);
    }
    for (const file of [
      'unix-shell.data',
      'windows-powershell-commands.data',
      'php-function-names-933150.data',
    ]) {
      const line = `SecRule ARGS "@pmFromFile @owasp_crs/${file}" "id:9323,deny"`;
      expect(filterCustomDirectives(line, { crsLoaded: true })).toEqual({
        kept: [line],
        dropped: [],
      });
      expect(customDirectivesError(line, { crsLoaded: true })).toBeNull();
    }
  });

  it('emits the rule only when the handler loads the CRS', () => {
    expect(
      buildWafHandler({ ...baseWaf, load_owasp_crs: true, custom_directives: crsRule }).directives,
    ).toContain(crsRule);
    expect(
      buildWafHandler({ ...baseWaf, load_owasp_crs: false, custom_directives: crsRule }).directives,
    ).not.toContain(crsRule);
  });
});

describe('buildWafHandler - dropped directive warning', () => {
  afterEach(() => {
    for (const mock of mocks.splice(0)) mock.mockRestore();
  });
  const mocks: ReturnType<typeof spyOn>[] = [];
  const silenceWarn = () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    mocks.push(warn);
    return warn;
  };
  const build = (
    waf: Parameters<typeof buildWafHandler>[0],
    source?: Parameters<typeof buildWafHandler>[3],
  ) => buildWafHandler(waf, new Map(), new Map(), source);

  it('logs the dropped lines once per source and content', () => {
    const warn = silenceWarn();
    const waf = {
      ...baseWaf,
      custom_directives: 'SecRule ARGS "@pmFromFile /etc/warn-test" "id:9401,deny"',
    };
    build(waf, 'proxy host "app.example.com"');
    build(waf, 'proxy host "app.example.com"');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('proxy host "app.example.com"');
    expect(message).toContain('@pmFromFile /etc/warn-test');
    expect(message).toContain('reads files or runs programs');

    build(waf, 'proxy host "other.example.com"');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs nothing without a source, as for a dry run', () => {
    const warn = silenceWarn();
    build({ ...baseWaf, custom_directives: 'SecRule ARGS "@pmf /etc/warn-silent" "id:9409,deny"' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports global lines under the global settings, once, and host lines under the host', () => {
    const warn = silenceWarn();
    const globalRule = 'SecRule ARGS "@pmFromFile /etc/warn-global" "id:9403,deny"';
    const hostRule = 'SecRule ARGS "@pmFromFile /etc/warn-host" "id:9404,deny"';
    const global = { ...baseWaf, custom_directives: `\n# global\n${globalRule}` };
    const hosts = [
      { label: 'proxy host "a"', config: { enabled: true, custom_directives: hostRule } },
      { label: 'proxy host "b"', config: { enabled: true } },
      { label: 'proxy host "c"', config: null },
    ];
    for (const { label, config } of hosts) {
      const effective = resolveEffectiveWaf(global, config);
      if (effective) build(effective, wafDirectiveSource(global, config, label));
    }

    const messages = warn.mock.calls.map((args) => String(args[0]));
    const globalWarnings = messages.filter((message) => message.includes('warn-global'));
    expect(globalWarnings).toHaveLength(1);
    expect(globalWarnings[0]).toContain(`[waf] ${GLOBAL_WAF_SOURCE}:`);
    expect(globalWarnings[0]).not.toContain('warn-host');
    const hostWarnings = messages.filter((message) => message.includes('warn-host'));
    expect(hostWarnings).toHaveLength(1);
    expect(hostWarnings[0]).toContain('[waf] proxy host "a":');
    expect(hostWarnings[0]).not.toContain('warn-global');
  });

  it("reports an override-mode host's lines under the host", () => {
    const warn = silenceWarn();
    const global = { ...baseWaf, custom_directives: 'SecRule ARGS "@contains x" "id:9405,deny"' };
    const config = {
      enabled: true,
      waf_mode: 'override' as const,
      custom_directives: 'SecRule ARGS "@pmFromFile /etc/warn-override" "id:9406,deny"',
    };
    const effective = resolveEffectiveWaf(global, config);
    if (effective) build(effective, wafDirectiveSource(global, config, 'proxy host "d"'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[waf] proxy host "d":');
  });

  it("reports a global chain the host's first line breaks under the host", () => {
    const warn = silenceWarn();
    const starter = 'SecRule REQUEST_URI "@beginsWith /admin" "id:9408,phase:2,deny,chain"';
    const child = 'SecRule ARGS "@pmFromFile /etc/warn-chain" "t:none"';
    const global = { ...baseWaf, custom_directives: starter };
    const config = { enabled: true, custom_directives: child };
    const effective = resolveEffectiveWaf(global, config);
    if (effective) build(effective, wafDirectiveSource(global, config, 'proxy host "J"'));
    const messages = warn.mock.calls.map((args) => String(args[0]));
    expect(messages).toHaveLength(2);
    const fromGlobal = messages.find((m) =>
      m.startsWith(`[waf] proxy host "J", from the ${GLOBAL_WAF_SOURCE}:`),
    );
    expect(fromGlobal).toContain(`"${starter}" -> part of a chained rule`);
    const fromHost = messages.find((m) => m.startsWith('[waf] proxy host "J":'));
    expect(fromHost).toContain(`"${child}" -> @pmFromFile reads files`);
    expect(fromHost).not.toContain('id:9408');
  });

  it('stays quiet when every directive is kept', () => {
    const warn = silenceWarn();
    build(
      { ...baseWaf, custom_directives: 'SecRule ARGS "@contains quiet" "id:9402,deny"' },
      'quiet',
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('customDirectivesError', () => {
  it('names an out-of-range body limit first, then dropped lines, and null when all are kept', () => {
    expect(customDirectivesError('SecRequestBodyLimit 10737418240')?.message).toMatch(
      /out-of-range body limit/,
    );
    expect(customDirectivesError('Include /etc/passwd')?.message).toMatch(
      /would be dropped and never sent to Caddy/,
    );
    expect(customDirectivesError('SecRule ARGS "@contains x" "id:9501,deny"')).toBeNull();
    expect(customDirectivesError('')).toBeNull();
  });

  it('uses the codes of the field it checks', () => {
    expect(customDirectivesError('Include /x', {}, undefined, 'host')?.code).toBe(
      'wafDirectivesDropped',
    );
    expect(customDirectivesError('Include /x', {}, undefined, 'preset')?.code).toBe(
      'wafPresetDirectivesDropped',
    );
    expect(customDirectivesError('Include /x')?.status).toBe(400);
  });

  it('passes the CRS state through to the filter', () => {
    const rule = 'SecRule ARGS "@pmf @owasp_crs/unix-shell.data" "id:9502,deny"';
    expect(customDirectivesError(rule, { crsLoaded: true })).toBeNull();
    expect(customDirectivesError(rule, { crsLoaded: false })?.message).toMatch(
      /OWASP CRS is loaded/,
    );
  });
});

// Against the stored value only what the change newly drops is an error: a stored rule a later
// release started dropping must not block other edits, but nothing new may be dropped silently.
describe('customDirectivesError - against the stored directives', () => {
  const legacy =
    'SecRule REMOTE_ADDR "@ipMatchFromFile /etc/caddy/blocklist.txt" "id:9601,phase:1,deny"';
  const kept = 'SecRule ARGS "@contains x" "id:9602,deny"';
  const crsRule = 'SecRule ARGS "@pmf @owasp_crs/unix-shell.data" "id:9603,deny"';

  it('accepts a stored dropped line left in place, alone or beside new kept lines', () => {
    const previous = { directives: legacy };
    expect(customDirectivesError(legacy, {}, previous)).toBeNull();
    expect(customDirectivesError(`  ${legacy}  \r\n${kept}`, {}, previous)).toBeNull();
  });

  it('rejects a newly dropped line and reports only that one', () => {
    const added = 'SecRule ARGS "@pmFromFile /etc/hosts" "id:9604,deny"';
    const message = customDirectivesError(
      `${legacy}\n${added}`,
      {},
      { directives: legacy },
    )?.message;
    expect(message).toMatch(/has 1 line that would be dropped/);
    expect(message).toContain(added);
    expect(message).not.toContain('id:9601');
  });

  it('rejects a second copy of a stored dropped line', () => {
    expect(
      customDirectivesError(`${legacy}\n${legacy}`, {}, { directives: legacy })?.message,
    ).toMatch(/ipMatchFromFile reads files/);
  });

  it('rejects turning the CRS off under an unchanged rule that needs it', () => {
    const previous = { directives: crsRule, options: { crsLoaded: true } };
    expect(customDirectivesError(crsRule, { crsLoaded: true }, previous)).toBeNull();
    expect(customDirectivesError(crsRule, { crsLoaded: false }, previous)?.message).toMatch(
      /OWASP CRS is loaded/,
    );
    expect(
      customDirectivesError(
        crsRule,
        { crsLoaded: false },
        { directives: crsRule, options: { crsLoaded: false } },
      ),
    ).toBeNull();
  });

  it('rejects a kept line a newly added chain starter drags along', () => {
    const starter = 'SecRule REQUEST_URI "@beginsWith /admin" "id:9605,deny,chain"';
    const message = customDirectivesError(
      `${starter}\n${legacy}`,
      {},
      { directives: legacy },
    )?.message;
    expect(message).toContain(starter);
    expect(message).toMatch(/part of a chained rule/);
  });

  it('keeps the body-limit message for a newly out-of-range body limit', () => {
    expect(
      customDirectivesError(
        `${legacy}\nSecRequestBodyLimit 10737418240`,
        {},
        { directives: legacy },
      )?.message,
    ).toMatch(/out-of-range body limit: "SecRequestBodyLimit 10737418240"/);
    expect(
      customDirectivesError(
        'SecRequestBodyLimit 10737418240',
        {},
        { directives: 'SecRequestBodyLimit 10737418240' },
      ),
    ).toBeNull();
  });

  it('accepts a stored duplicate left in place, but not another copy', () => {
    const rule = 'SecRule REQUEST_URI "@beginsWith /api/" "id:9001,phase:1,pass,nolog"';
    const stored = `${rule}\n${rule}`;
    expect(customDirectivesError(stored, {}, { directives: stored })).toBeNull();
    expect(
      customDirectivesError(`${stored}\n${rule}`, {}, { directives: stored })?.message,
    ).toMatch(/rule id 9001/);
  });
});

// Stored lines that predate a filter rule are left out; a left-out deny rule silently stops
// blocking, so the WAF page lists them.
describe('listDroppedWafDirectives', () => {
  const fromFile =
    'SecRule REMOTE_ADDR "!@ipMatchFromFile /data/allow.txt" "id:9501,phase:1,deny,status:403"';
  const kept = 'SecRule ARGS "@contains evil" "id:9502,deny"';

  it('lists global and host lines under their source, once each', () => {
    const global = { ...baseWaf, custom_directives: `${fromFile}\n${kept}` };
    const hosts = [
      { name: 'inherits', domains: ['a.example.com'], waf: null },
      {
        name: 'merged',
        domains: ['b.example.com'],
        waf: {
          enabled: true,
          waf_mode: 'merge' as const,
          custom_directives: 'SecAction "id:9601,phase:1,setenv:X=1"',
        },
      },
    ];
    const reports = listDroppedWafDirectives(global, hosts);
    expect(reports.map(({ origin, host, line }) => [origin, host?.name ?? null, line])).toEqual([
      ['global', null, fromFile],
      ['host', 'merged', 'SecAction "id:9601,phase:1,setenv:X=1"'],
    ]);
    expect(reports[0].reason).toBe('wafDirectiveDroppedFileOperator');
    expect(reports[1].host?.domains).toEqual(['b.example.com']);
  });

  it('names the host whose own CRS setting drops a global line', () => {
    const crsRule = 'SecRule ARGS "@pmf @owasp_crs/unix-shell.data" "id:9701,deny"';
    const global = { ...baseWaf, load_owasp_crs: true, custom_directives: crsRule };
    const hosts = [
      {
        name: 'crs-off',
        domains: ['c.example.com'],
        waf: { enabled: true, load_owasp_crs: false },
      },
    ];
    expect(
      listDroppedWafDirectives(global, hosts).map(({ origin, host }) => [origin, host?.name]),
    ).toEqual([['hostFromGlobal', 'crs-off']]);
  });

  it('lists nothing for a WAF that is off or has only kept lines', () => {
    expect(
      listDroppedWafDirectives({ ...baseWaf, enabled: false, custom_directives: fromFile }, []),
    ).toEqual([]);
    expect(
      listDroppedWafDirectives({ ...baseWaf, mode: 'Off', custom_directives: fromFile }, []),
    ).toEqual([]);
    expect(listDroppedWafDirectives({ ...baseWaf, custom_directives: kept }, [])).toEqual([]);
  });
});

// Without the strict setting the same lines are sent, and the author is told why they matter; only
// what Coraza itself would refuse is still kept out.
describe('filterCustomDirectives - without the strict setting', () => {
  const fromFile = 'SecRule ARGS "@pmFromFile /etc/hosts" "id:9801,deny"';
  const engine = 'SecRuleEngine DetectionOnly';
  const audit = 'SecAuditEngine Off';
  const setenv = 'SecAction "id:9802,phase:1,pass,nolog,setenv:GODEBUG=x509sha1=1"';
  const include = 'Include /etc/caddy/extra.conf';
  const bogus = 'SecBogus On';
  const kept = 'SecRule ARGS "@contains x" "id:9803,deny"';

  it('keeps the risky lines and lists each with its reason', () => {
    const raw = [fromFile, engine, audit, setenv, include, kept].join('\n');
    expect(filterCustomDirectivesWith(raw)).toEqual({
      kept: [fromFile, engine, audit, setenv, include, kept],
      dropped: [],
    });
    expect(riskyDirectiveWarnings(raw)).toEqual([
      { line: fromFile, reason: 'wafDirectiveDroppedFileOperator', params: { name: 'pmFromFile' } },
      { line: engine, reason: 'wafDirectiveDroppedRuleMutation' },
      { line: audit, reason: 'wafDirectiveDroppedNotAllowed', params: { name: 'SecAuditEngine' } },
      { line: setenv, reason: 'wafDirectiveDroppedSetenv' },
      { line: include, reason: 'wafDirectiveDroppedInclude' },
    ]);
    expect(customDirectivesErrorWith(raw)).toBeNull();
  });

  it('still drops a directive Coraza does not know, in either mode', () => {
    for (const strictDirectives of [false, true]) {
      expect(filterCustomDirectivesWith(`${bogus}\n${kept}`, { strictDirectives })).toEqual({
        kept: [kept],
        dropped: [
          {
            line: bogus,
            reason: 'wafDirectiveDroppedUnknownDirective',
            params: { name: 'SecBogus' },
          },
        ],
      });
    }
    expect(customDirectivesErrorWith(bogus)?.message).toMatch(
      /SecBogus is not a directive Coraza knows/,
    );
  });

  it('still drops what Coraza would refuse to parse, with its chain', () => {
    const starter = 'SecRule REQUEST_URI "@beginsWith /admin" "id:9811,deny,chain"';
    const child = 'SecRule ARGS "@contains x" \'t:none\'';
    const { kept: left, dropped } = filterCustomDirectivesWith([starter, child, kept].join('\n'));
    expect(left).toEqual([kept]);
    expect(dropped.map((entry) => entry.reason)).toEqual([
      'wafDirectiveDroppedChainPart',
      'wafDirectiveDroppedUnparseable',
    ]);
  });

  it('lets a risky line take part in a chain and hold a rule id', () => {
    const starter = 'SecRule REQUEST_URI "@beginsWith /admin" "id:9821,deny,chain"';
    const child = 'SecRule REMOTE_ADDR "!@ipMatchFromFile allow.txt"';
    const again = 'SecAction "id:9821,phase:1,pass,nolog"';
    const { kept: left, dropped } = filterCustomDirectivesWith([starter, child, again].join('\n'));
    expect(left).toEqual([starter, child]);
    expect(dropped.map((entry) => entry.reason)).toEqual(['wafDirectiveDroppedDuplicateId']);
  });

  it('sends the risky lines to Caddy only without the strict setting', () => {
    const lenient = { ...baseWaf, strict_directives: false, custom_directives: fromFile };
    expect(buildWafHandler(lenient).directives).toContain(fromFile);
    expect(buildWafHandler({ ...lenient, strict_directives: true }).directives).not.toContain(
      fromFile,
    );
    // A host follows the global setting, whatever its own mode.
    const host = { enabled: true, waf_mode: 'override' as const, custom_directives: fromFile };
    for (const strictDirectives of [false, true]) {
      const global = { ...baseWaf, strict_directives: strictDirectives };
      const effective = resolveEffectiveWaf(global, host);
      const directives = buildWafHandler(
        effective!,
        new Map(),
        new Map(),
        wafDirectiveSource(global, host, 'proxy host "h"'),
      ).directives;
      expect(String(directives).includes(fromFile)).toBe(!strictDirectives);
    }
  });

  it('marks the lines for the editor as warnings, or errors with the strict setting', () => {
    const raw = `${kept}\n${fromFile}\n${bogus}`;
    expect(directivePolicyIssues(raw)).toEqual([
      {
        line: 2,
        severity: 'warning',
        code: 'wafDirectiveDroppedFileOperator',
        params: { name: 'pmFromFile' },
      },
      {
        line: 3,
        severity: 'error',
        code: 'wafDirectiveDroppedUnknownDirective',
        params: { name: 'SecBogus' },
      },
    ]);
    expect(directivePolicyIssues(raw, { strictDirectives: true }).map((i) => i.severity)).toEqual([
      'error',
      'error',
    ]);
    // What Coraza refuses to parse is the linter's to report, not repeated here.
    expect(directivePolicyIssues('SecRule ARGS "@contains x" \'id:1\'')).toEqual([]);
  });

  it('lists nothing as dropped for a risky stored line, so the WAF page stays quiet', () => {
    expect(
      listDroppedWafDirectives(
        { ...baseWaf, strict_directives: false, custom_directives: fromFile },
        [],
      ),
    ).toEqual([]);
  });
});
