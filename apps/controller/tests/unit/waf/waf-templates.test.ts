/** Every WAF quick template must pass the allowlist, or it inserts a rule the save rejects. */
import { describe, it, expect } from 'bun:test';
import {
  customDirectivesError,
  filterCustomDirectives,
  resolveEffectiveWaf,
} from '../../../src/lib/waf/caddy';
import { seclangErrors } from '../../../src/lib/waf/seclang';
import {
  appendQuickTemplate,
  HOST_TEMPLATE_ID_OFFSET,
  WAF_QUICK_TEMPLATES,
} from '../../../src/lib/waf/templates';
import messages from '../../../messages/en.json';

describe('WAF quick templates', () => {
  for (const template of WAF_QUICK_TEMPLATES) {
    it(`${template.id} passes the custom-directive allowlist untouched, CRS or not`, () => {
      for (const crsLoaded of [true, false, undefined]) {
        const { kept, dropped } = filterCustomDirectives(template.snippet, { crsLoaded });
        expect(dropped).toEqual([]);
        expect(kept.join('\n')).toBe(template.snippet);
        expect(customDirectivesError(template.snippet, { crsLoaded })).toBeNull();
      }
      expect(seclangErrors(template.snippet, { crsLoaded: true })).toEqual([]);
    });
  }

  it('gives every template its own rule id, so inserting several cannot collide', () => {
    const ids = WAF_QUICK_TEMPLATES.map((template) => /\bid:(\d+)/.exec(template.snippet)?.[1]);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const all = WAF_QUICK_TEMPLATES.map((t) => t.snippet).join('\n');
    expect(filterCustomDirectives(all, { crsLoaded: true }).dropped).toEqual([]);
  });

  it('has a label for every template', () => {
    // The key is composed at runtime, so tsc cannot check it.
    const labels = messages.waf.templates as Record<string, string>;
    for (const template of WAF_QUICK_TEMPLATES) expect(labels[template.id]).toBeTruthy();
  });
});

// The raw REQUEST_URI of /api/../admin starts with /api/, and an upstream resolving dot-segments
// serves /admin; the path skips must not match it.
describe('WAF quick templates - path skips', () => {
  const pathSkips = WAF_QUICK_TEMPLATES.filter((t) => t.id.endsWith('ForPath'));
  // What the @rx argument would be in Go: the operator between its quotes, `\"` unescaped.
  const pattern = (snippet: string) => {
    const operator = /"@rx (.*?)" "/.exec(snippet)?.[1] ?? '';
    // \A and \z are Go's; JavaScript spells them ^ and $ without the m flag.
    return new RegExp(operator.replace(/^\\A/, '^').replace(/\\z$/, '$'), 's');
  };

  it('matches the decoded path, never the raw URI', () => {
    expect(pathSkips).toHaveLength(2);
    for (const { snippet } of pathSkips) {
      expect(snippet).toStartWith('SecRule REQUEST_FILENAME "@rx \\A/api/');
      expect(snippet).not.toContain('REQUEST_URI');
    }
  });

  it('skips paths under /api/ and refuses any with a dot-dot segment', () => {
    for (const { snippet } of pathSkips) {
      const rx = pattern(snippet);
      for (const path of ['/api/', '/api/users', '/api/v1/a.b/c', '/api/file.', '/api/.well-known'])
        expect(rx.test(path)).toBe(true);
      for (const path of [
        '/api/../admin',
        '/api/..',
        '/api/a/../../x',
        '/apix',
        '/x/api/',
        '/API/',
      ])
        expect(rx.test(path)).toBe(false);
    }
  });
});

describe('appendQuickTemplate', () => {
  it('inserts a template as is into an empty value, on a new line otherwise', () => {
    const [first, second] = WAF_QUICK_TEMPLATES;
    expect(appendQuickTemplate('', first)).toBe(first.snippet);
    expect(appendQuickTemplate('# mine', second)).toBe(`# mine\n${second.snippet}`);
  });

  it('moves the rule id past the ids in use, so clicking templates again stays loadable', () => {
    let global = '';
    let host = '';
    for (let round = 0; round < 3; round++) {
      for (const template of WAF_QUICK_TEMPLATES) {
        global = appendQuickTemplate(global, template);
        host = appendQuickTemplate(host, template, HOST_TEMPLATE_ID_OFFSET);
      }
    }
    expect(global.split('\n')).toHaveLength(3 * WAF_QUICK_TEMPLATES.length);
    expect(filterCustomDirectives(global, { crsLoaded: true }).dropped).toEqual([]);
    expect(
      customDirectivesError(host, { crsLoaded: true, precedingDirectives: global }),
    ).toBeNull();
    const merged = resolveEffectiveWaf(
      { enabled: true, mode: 'On', load_owasp_crs: true, custom_directives: global },
      { enabled: true, custom_directives: host },
    );
    expect(filterCustomDirectives(merged?.custom_directives, { crsLoaded: true }).dropped).toEqual(
      [],
    );
  });

  it('skips an id a commented-out or spaced rule already uses', () => {
    const allowIp = WAF_QUICK_TEMPLATES[0];
    expect(appendQuickTemplate('# SecAction "id: 9000,pass"', allowIp)).toContain('id:9001,');
  });
});
