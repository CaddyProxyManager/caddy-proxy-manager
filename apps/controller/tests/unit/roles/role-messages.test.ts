/**
 * The Roles page names each capability resource and each built-in role through keys composed at
 * runtime, which tsc cannot check: the catalog must have every one.
 */
import { describe, expect, it } from 'bun:test';
import messages from '../../../messages/en.json';
import { BUILT_IN_ROLE_KEYS } from '@/src/lib/roles/built-in';
import { CAPABILITY_RESOURCE_LIST } from '@/src/lib/roles/capabilities';

const roles = messages.roles as unknown as {
  resources: Record<string, { label?: string; help?: string }>;
  builtInHelp: Record<string, string>;
};

describe('the roles catalog', () => {
  it('names and explains every capability resource, and nothing else', () => {
    for (const resource of CAPABILITY_RESOURCE_LIST) {
      expect(typeof roles.resources[resource]?.label, resource).toBe('string');
      expect(typeof roles.resources[resource]?.help, resource).toBe('string');
    }
    expect(Object.keys(roles.resources).sort()).toEqual([...CAPABILITY_RESOURCE_LIST].sort());
  });

  it('explains every built-in role', () => {
    expect(Object.keys(roles.builtInHelp).sort()).toEqual([...BUILT_IN_ROLE_KEYS].sort());
    expect(Object.keys(messages.users.roles).sort()).toEqual([...BUILT_IN_ROLE_KEYS].sort());
  });
});
