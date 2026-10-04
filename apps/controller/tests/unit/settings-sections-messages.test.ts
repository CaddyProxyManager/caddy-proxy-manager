/**
 * Section and group keys are composed at runtime, so tsc cannot check them. The English must also
 * match `sections.ts` exactly, since e2e finds the rail's links by that text.
 */
import { describe, expect, it } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';
import {
  SETTINGS_BLOCKS,
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
  settingsBlockName,
  sectionMessageName,
  settingsGroupLabel,
  settingsSectionDescription,
  settingsSectionName,
} from '@/src/app/(dashboard)/settings/sections';

const t = createTranslator({ locale: 'en', messages, namespace: 'settings' });

describe('settings.sections messages', () => {
  it('names and describes every section as sections.ts does', () => {
    const mismatches = SETTINGS_ITEMS.flatMap((item) => [
      ...(settingsSectionName(t, item) === item.name ? [] : [`${item.id}.name`]),
      ...(settingsSectionDescription(t, item) === item.desc ? [] : [`${item.id}.desc`]),
    ]);
    expect(mismatches).toEqual([]);
  });

  it('names every block as sections.ts does', () => {
    const mismatches = SETTINGS_BLOCKS.flatMap((block) =>
      settingsBlockName(t, block.id) === block.name ? [] : [`${block.id}.name`],
    );
    expect(mismatches).toEqual([]);
  });

  it('has no block entry for a block that no longer exists', () => {
    const known = new Set(SETTINGS_BLOCKS.map((block) => sectionMessageName(block.id)));
    expect(Object.keys(messages.settings.blocks).filter((name) => !known.has(name))).toEqual([]);
  });

  it('has no entry for a section that no longer exists', () => {
    const known = new Set(SETTINGS_ITEMS.map((item) => sectionMessageName(item.id)));
    expect(Object.keys(messages.settings.sections).filter((name) => !known.has(name))).toEqual([]);
  });
});

describe('settings.navGroups messages', () => {
  it('labels every group as sections.ts does', () => {
    const mismatches = SETTINGS_GROUPS.filter(
      (group) => settingsGroupLabel(t, group) !== group.label,
    ).map((group) => group.id);
    expect(mismatches).toEqual([]);
  });

  it('has no entry for a group that no longer exists', () => {
    const known = new Set(SETTINGS_GROUPS.map((group) => sectionMessageName(group.id)));
    expect(Object.keys(messages.settings.navGroups).filter((name) => !known.has(name))).toEqual([]);
  });
});
