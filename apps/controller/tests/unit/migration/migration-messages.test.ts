/** Group keys are composed at runtime, so tsc cannot check them against the catalog. */
import { describe, expect, it } from 'bun:test';
import messages from '../../../messages/en.json';
import { MIGRATION_GROUPS } from '@/src/lib/migration/selection';

const catalog = messages.setup.migrationGroups as Record<
  string,
  { label?: string; description?: string } | undefined
>;

describe('setup.migrationGroups messages', () => {
  it('covers every group in the selection', () => {
    const missing = MIGRATION_GROUPS.filter(
      (group) => !catalog[group.id]?.label || !catalog[group.id]?.description,
    ).map((group) => group.id);
    expect(missing).toEqual([]);
  });

  it('carries the same English as selection.ts, which stays the source', () => {
    for (const group of MIGRATION_GROUPS) {
      expect(catalog[group.id]?.label).toBe(group.label);
      expect(catalog[group.id]?.description).toBe(group.description);
    }
  });

  it('has no entry for a group that no longer exists', () => {
    const known = new Set<string>(MIGRATION_GROUPS.map((group) => group.id));
    expect(Object.keys(catalog).filter((id) => !known.has(id))).toEqual([]);
  });
});
