/** Every WAF quick template must pass the allowlist, or it inserts a rule the save rejects. */
import { describe, it, expect } from 'bun:test';
import { filterCustomDirectives } from '../../src/lib/caddy-waf';
import { WAF_QUICK_TEMPLATES } from '../../src/lib/waf-templates';
import messages from '../../messages/en.json';

describe('WAF quick templates', () => {
  for (const template of WAF_QUICK_TEMPLATES) {
    it(`${template.id} passes the custom-directive allowlist untouched`, () => {
      const { kept, dropped } = filterCustomDirectives(template.snippet);
      expect(dropped).toEqual([]);
      expect(kept.join('\n')).toBe(template.snippet);
    });
  }

  it('gives every template its own rule id, so inserting several cannot collide', () => {
    const ids = WAF_QUICK_TEMPLATES.map((template) => /\bid:(\d+)/.exec(template.snippet)?.[1]);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a label for every template', () => {
    // The key is composed at runtime, so tsc cannot check it.
    const labels = messages.waf.templates as Record<string, string>;
    for (const template of WAF_QUICK_TEMPLATES) expect(labels[template.id]).toBeTruthy();
  });
});
