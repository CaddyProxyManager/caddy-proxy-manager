/** Settings search: plain words and catalog synonyms finding the block or page that has them. */
import { describe, expect, it } from 'bun:test';
import { testTranslator } from '../../helpers/next-intl';
import messages from '../../../messages/en.json';
import {
  EXTRA_SEARCH_PAGES,
  searchSettings,
  settingsSearchEntries,
} from '../../../src/app/(dashboard)/settings/search-index';
import {
  SETTINGS_BLOCKS,
  sectionMessageName,
} from '../../../src/app/(dashboard)/settings/sections';

const entries = settingsSearchEntries(testTranslator('settings') as never);
const first = (query: string) => searchSettings(entries, query)[0]?.id;

describe('settings search', () => {
  it('finds a block by a word it never shows', () => {
    expect(first('prometheus')).toBe('metrics');
    expect(first('redis')).toBe('http-cache');
    expect(first('smtp')).toBe('email');
    expect(first('mfa')).toBe('two-factor');
  });

  it('finds the pages outside the settings sections', () => {
    expect(first('rate limiting')).toBe('rate-limit');
    expect(first('paranoia')).toBe('page:waf-tuning');
    expect(first('blocked sources')).toBe('page:blocked-sources');
    expect(first('portable')).toBe('page:portable-config');
    expect(first('sign-in overview')).toBe('page:sign-in-overview');
  });

  it('ranks a title over a synonym, ignores accents and case, and needs every word', () => {
    expect(first('COMPRESSIÓN')).toBe('compression');
    expect(searchSettings(entries, 'smtp nonsense-word')).toEqual([]);
    expect(searchSettings(entries, '   ')).toEqual([]);
  });

  it('links every result somewhere', () => {
    for (const entry of entries) {
      expect(entry.href.startsWith('/')).toBe(true);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it('has a title and context for every extra page, and synonyms only for things that exist', () => {
    const t = testTranslator('settings');
    for (const page of EXTRA_SEARCH_PAGES) {
      expect(t.has(`search.pages.${sectionMessageName(page.id)}.title`)).toBe(true);
      expect(t.has(`search.pages.${sectionMessageName(page.id)}.context`)).toBe(true);
    }
    const known = new Set([
      ...SETTINGS_BLOCKS.map((block) => sectionMessageName(block.id)),
      ...EXTRA_SEARCH_PAGES.map((page) => sectionMessageName(page.id)),
    ]);
    const synonyms = Object.keys(messages.settings.search.synonyms);
    expect(synonyms.filter((key) => !known.has(key))).toEqual([]);
  });
});
