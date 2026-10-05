/**
 * Section labels are looked up by runtime id, which tsc cannot check: a section without a message
 * fails here, and the English must match the module's own label.
 */
import { describe, expect, it } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../messages/en.json';
import {
  SECTION_STORAGE_KEYS,
  stagedChangeLabel,
  stagedLabelMessageName,
} from '@/src/lib/settings/section-keys';

const t = createTranslator({ locale: 'en', messages, namespace: 'settings' });

describe('settings.stagedLabels messages', () => {
  it('labels every section as section-keys.ts does', () => {
    const mismatches = Object.entries(SECTION_STORAGE_KEYS)
      .filter(([id, entry]) => stagedChangeLabel(t, { sectionId: id, label: '' }) !== entry.label)
      .map(([id]) => id);
    expect(mismatches).toEqual([]);
  });

  it('has no entry for a section that no longer exists', () => {
    const known = new Set(Object.keys(SECTION_STORAGE_KEYS).map(stagedLabelMessageName));
    expect(Object.keys(messages.settings.stagedLabels).filter((name) => !known.has(name))).toEqual(
      [],
    );
  });

  it('keeps the staged name of a key no section claims', () => {
    expect(stagedChangeLabel(t, { sectionId: null, label: 'mystery_key' })).toBe('mystery_key');
  });
});
