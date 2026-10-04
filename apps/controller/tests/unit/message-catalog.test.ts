/** Catalog shape rules: none of these fail a build, they render to the user as typos. */
import { describe, expect, it } from 'bun:test';
import { createTranslator, IntlErrorCode } from 'next-intl';
import messages from '../../messages/en.json';

type Node = { [key: string]: string | Node };

function entries(node: Node, prefix = ''): Array<[string, string]> {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[`${prefix}${key}`, value] as [string, string]]
      : entries(value, `${prefix}${key}.`),
  );
}

const ALL = entries(messages as unknown as Node);

describe('message catalog', () => {
  it('is not empty, so a broken import cannot pass these silently', () => {
    expect(ALL.length).toBeGreaterThan(500);
  });

  it('wraps no message by hand', () => {
    // Line breaks belong to layout, which wraps every language alike.
    const offenders = ALL.filter(([, value]) => /\n|\t| {2,}/.test(value)).map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it('parses every message, so none renders as its own key', () => {
    // `<host>` reads as an unclosed rich-text tag and renders the key; quote it as `'<host>'`.
    // The empty values object matters: without it the message is returned unparsed.
    const unparseable: string[] = [];
    const t = createTranslator({
      locale: 'en',
      messages,
      onError: (error) => {
        if (error.code === IntlErrorCode.INVALID_MESSAGE) unparseable.push(error.message);
      },
    }) as unknown as (key: string, values: Record<string, never>) => string;

    for (const [key] of ALL) {
      const before = unparseable.length;
      t(key, {});
      if (unparseable.length > before) unparseable[unparseable.length - 1] = key;
    }
    expect(unparseable).toEqual([]);
  });

  it('carries no leading or trailing whitespace', () => {
    expect(ALL.filter(([, v]) => v !== v.trim()).map(([k]) => k)).toEqual([]);
  });

  it('spells characters out rather than escaping them as HTML entities', () => {
    // `{t("...")}` renders a string, so `&mdash;` would reach the page as those nine characters.
    const offenders = ALL.filter(([, value]) => /&[a-zA-Z]+;|&#\d+;/.test(value)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('has no empty message', () => {
    expect(ALL.filter(([, value]) => value.trim() === '').map(([key]) => key)).toEqual([]);
  });

  it('names keys in camelCase, with no entity fragments left by slugging', () => {
    // settings.registry.* uses storage names (`app_name`), which settingMessageName() looks up.
    const offenders = ALL.filter(([key]) => !key.startsWith('settings.registry.'))
      .filter(([key]) => key.split('.').some((part) => !/^[a-z][A-Za-z0-9]*$/.test(part)))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it('keys settings.registry by the registry name, not a camelCased one', () => {
    const registry = ALL.filter(([key]) => key.startsWith('settings.registry.'));
    expect(registry.length).toBeGreaterThan(0);
    for (const [key] of registry) {
      const [, , name, field] = key.split('.');
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      // fieldLabel: a number setting's label without the unit its Settings field shows apart.
      expect(['label', 'description', 'fieldLabel']).toContain(field);
    }
  });
});

describe('message catalog source', () => {
  it('names no key twice in one object, where the later would silently replace the earlier', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const text = readFileSync(join(import.meta.dir, '../../messages/en.json'), 'utf8');
    const duplicates: string[] = [];
    // JSON.parse keeps the last of a repeated key, so keys are read off the text; strings are
    // tokens, so a `{name}` placeholder never counts as a brace.
    const stack: Set<string>[] = [];
    for (const token of text.matchAll(/"((?:[^"\\]|\\.)*)"(\s*:)?|[{}]/g)) {
      if (token[0] === '{') stack.push(new Set());
      else if (token[0] === '}') stack.pop();
      else if (token[2]) {
        const keys = stack.at(-1);
        if (keys?.has(token[1])) duplicates.push(token[1]);
        keys?.add(token[1]);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
