/**
 * The catalog people's roles are made of. Each capability still names a token area, so a scoped
 * token keeps narrowing whatever a role holds; and a role is only ever handed out, or written,
 * by someone holding all of it outright.
 */
import { describe, expect, it } from 'bun:test';
import { TOKEN_AREAS } from '@/src/lib/api-tokens/scope';
import { BUILT_IN_ROLES } from '@/src/lib/roles/built-in';
import {
  CAPABILITIES,
  CAPABILITY_RESOURCE_LIST,
  capabilityArea,
  capabilitySetOf,
  covers,
  holds,
  isCapability,
  normalizeCapabilities,
  reaches,
} from '@/src/lib/roles/capabilities';

describe('the capability catalog', () => {
  it('reads and writes every resource, each in a token area', () => {
    expect(CAPABILITIES).toHaveLength(CAPABILITY_RESOURCE_LIST.length * 2);
    for (const capability of CAPABILITIES) {
      expect(TOKEN_AREAS).toContain(capabilityArea(capability).area);
    }
  });

  it('covers every token area, so no area is left without a capability', () => {
    const areas = new Set(CAPABILITIES.map((capability) => capabilityArea(capability).area));
    expect([...areas].sort()).toEqual([...TOKEN_AREAS].sort());
  });

  it('knows its own names and nothing else', () => {
    expect(isCapability('hosts:write')).toBe(true);
    expect(isCapability('hosts:delete')).toBe(false);
    expect(isCapability(7)).toBe(false);
  });

  it('normalizes a list: each write brings its read, unknown names drop, catalog order', () => {
    expect(normalizeCapabilities(['users:write', 'nope', 'hosts:read', 'users:write'])).toEqual([
      'hosts:read',
      'users:read',
      'users:write',
    ]);
  });
});

describe('a set of roles', () => {
  it('reaches hosts and agents only through grants when scoped', () => {
    const set = capabilitySetOf([BUILT_IN_ROLES.operator]);
    expect(set['hosts:write']).toBe('granted');
    expect(holds(set, 'hosts:write')).toBe(false);
    expect(reaches(set, 'hosts:write')).toBe(true);
  });

  it('holds anything not object-bound outright, scoped or not', () => {
    const set = capabilitySetOf([
      { key: 'r', capabilities: ['settings:write', 'hosts:read'], scoped: true },
    ]);
    expect(set['settings:write']).toBe('all');
    expect(set['hosts:read']).toBe('granted');
  });

  it('takes the widest reach of each capability across roles', () => {
    const set = capabilitySetOf([
      BUILT_IN_ROLES.operator,
      { key: 'r', capabilities: ['hosts:read'], scoped: false },
    ]);
    expect(set['hosts:read']).toBe('all');
    expect(set['hosts:write']).toBe('granted');
  });

  it('gives an administrator everything outright and the others what they say', () => {
    const admin = capabilitySetOf([BUILT_IN_ROLES.admin]);
    expect(CAPABILITIES.every((capability) => holds(admin, capability))).toBe(true);
    expect(capabilitySetOf([BUILT_IN_ROLES.user])).toEqual({});
    expect(capabilitySetOf([BUILT_IN_ROLES.viewer])).toEqual({});
  });
});

describe('covers', () => {
  const auditor = { key: 'auditor', capabilities: ['audit:read' as const], scoped: false };

  it('needs every capability of the role, held outright', () => {
    expect(covers(capabilitySetOf([BUILT_IN_ROLES.admin]), auditor)).toBe(true);
    expect(covers(capabilitySetOf([auditor]), auditor)).toBe(true);
    expect(covers({}, auditor)).toBe(false);
  });

  it('is not met by grants, even for a scoped role', () => {
    expect(covers(capabilitySetOf([BUILT_IN_ROLES.operator]), BUILT_IN_ROLES.operator)).toBe(false);
  });

  it('is met for a role that holds nothing', () => {
    expect(covers({}, BUILT_IN_ROLES.viewer)).toBe(true);
  });
});
