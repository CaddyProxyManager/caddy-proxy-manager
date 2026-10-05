import { describe, expect, it } from 'bun:test';
import { DomainError } from '../../../src/lib/errors/domain-error';
import { parseHostTags } from '../../../src/lib/forms/form-parse';
import {
  HOST_TAG_MAX_LENGTH,
  HOST_TAGS_MAX,
  hostTagProblem,
} from '../../../src/lib/proxy-hosts/tag-rules';
import {
  collectTags,
  normalizeHostTags,
  parseStoredTags,
  withHostTags,
} from '../../../src/lib/proxy-hosts/tags';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(400);
    return (error as DomainError).code;
  }
  return undefined;
}

describe('normalizeHostTags', () => {
  it('leaves an absent value alone and clears a null one', () => {
    expect(normalizeHostTags(undefined)).toBeUndefined();
    expect(normalizeHostTags(null)).toEqual([]);
  });

  it('lowercases, trims, drops blanks, deduplicates and sorts', () => {
    expect(normalizeHostTags([' Prod ', 'team:web', 'prod', '', '  ', 'A1'])).toEqual([
      'a1',
      'prod',
      'team:web',
    ]);
  });

  it('accepts the documented punctuation after the first character', () => {
    expect(normalizeHostTags(['env/prod-eu_1.2:a'])).toEqual(['env/prod-eu_1.2:a']);
    expect(normalizeHostTags(['überwachung'])).toEqual(['überwachung']);
  });

  it('refuses a tag starting with punctuation or holding anything else', () => {
    for (const tag of ['-prod', '.x', 'two words', 'quote"d', 'back\\slash', 'per%cent', 'a,b']) {
      expect(codeOf(() => normalizeHostTags([tag]))).toBe('hostTagInvalid');
    }
  });

  it('refuses a tag over the length limit, counting characters', () => {
    expect(normalizeHostTags(['a'.repeat(HOST_TAG_MAX_LENGTH)])).toHaveLength(1);
    expect(codeOf(() => normalizeHostTags(['a'.repeat(HOST_TAG_MAX_LENGTH + 1)]))).toBe(
      'hostTagTooLong',
    );
    expect(normalizeHostTags(['ü'.repeat(HOST_TAG_MAX_LENGTH)])).toHaveLength(1);
  });

  it('refuses more tags than a host may carry, after deduplication', () => {
    const many = Array.from({ length: HOST_TAGS_MAX }, (_, i) => `t${i}`);
    expect(normalizeHostTags([...many, 'T0'])).toHaveLength(HOST_TAGS_MAX);
    expect(codeOf(() => normalizeHostTags([...many, 'extra']))).toBe('hostTooManyTags');
  });

  it('refuses something that is not a list of strings', () => {
    expect(codeOf(() => normalizeHostTags('prod'))).toBe('hostTagsInvalid');
    expect(codeOf(() => normalizeHostTags([1]))).toBe('hostTagsInvalid');
  });
});

describe('hostTagProblem', () => {
  it('says why, for the editor', () => {
    expect(hostTagProblem('ok')).toBeNull();
    expect(hostTagProblem('_x')).toBe('invalid');
    expect(hostTagProblem('x'.repeat(HOST_TAG_MAX_LENGTH + 1))).toBe('tooLong');
  });
});

describe('stored tags', () => {
  it('reads a missing or malformed column as none', () => {
    expect(parseStoredTags(null)).toEqual([]);
    expect(parseStoredTags('not json')).toEqual([]);
    expect(parseStoredTags('{"a":1}')).toEqual([]);
    expect(parseStoredTags('["a",2,"b"]')).toEqual(['a', 'b']);
  });

  it('adds to what a host has, normalised whole', () => {
    expect(withHostTags('["web"]', ['Prod'])).toBe('["prod","web"]');
    expect(withHostTags('["prod"]', ['prod'])).toBe('["prod"]');
    const full = JSON.stringify(Array.from({ length: HOST_TAGS_MAX }, (_, i) => `t${i}`));
    expect(codeOf(() => withHostTags(full, ['one-more']))).toBe('hostTooManyTags');
  });

  it('collects every tag in use once', () => {
    expect(collectTags([{ tags: '["b","a"]' }, { tags: '["a"]' }, { tags: null }])).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('parseHostTags', () => {
  it('reads one field per chip behind the marker', () => {
    const form = new FormData();
    form.append('tagsPresent', '1');
    form.append('tag', 'prod');
    form.append('tag', 'web');
    expect(parseHostTags(form)).toEqual(['prod', 'web']);
  });

  it('reads every chip removed as an empty list, and no editor as no change', () => {
    const cleared = new FormData();
    cleared.append('tagsPresent', '1');
    expect(parseHostTags(cleared)).toEqual([]);
    expect(parseHostTags(new FormData())).toBeUndefined();
  });
});
