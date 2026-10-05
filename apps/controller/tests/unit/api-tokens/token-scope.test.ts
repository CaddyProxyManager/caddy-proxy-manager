import { describe, expect, it } from 'bun:test';
import {
  FULL_SCOPE,
  flattenScope,
  parseTokenScope,
  scopeAllows,
  scopeFromColumns,
  scopeToColumns,
  unflattenScope,
} from '../../../src/lib/api-tokens/scope';
import { resolveTokenExpiry } from '../../../src/lib/api-tokens/expiry';
import { DomainError } from '../../../src/lib/errors/domain-error';

function codeOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'other';
  }
  return null;
}

describe('parseTokenScope', () => {
  it('defaults to full, as every token before scopes had', () => {
    expect(parseTokenScope(undefined, undefined)).toEqual(FULL_SCOPE);
    expect(parseTokenScope('', null)).toEqual(FULL_SCOPE);
    expect(parseTokenScope('full', ['hosts:read'])).toEqual(FULL_SCOPE);
  });

  it('keeps a write and drops the read it implies, in area order', () => {
    expect(
      parseTokenScope('custom', ['settings:read', 'hosts:read', 'hosts:write', 'hosts:write']),
    ).toEqual({ kind: 'custom', permissions: ['hosts:write', 'settings:read'] });
  });

  it('refuses an unknown scope, an unknown permission and an empty custom list', () => {
    expect(codeOf(() => parseTokenScope('admin', []))).toBe('apiTokenScopeInvalid');
    expect(codeOf(() => parseTokenScope('custom', ['hosts:delete']))).toBe(
      'apiTokenPermissionInvalid',
    );
    expect(codeOf(() => parseTokenScope('custom', []))).toBe('apiTokenPermissionsRequired');
  });
});

describe('scopeAllows', () => {
  it('lets read-only read and nothing else', () => {
    expect(scopeAllows({ kind: 'read' }, 'hosts', 'read')).toBe(true);
    expect(scopeAllows({ kind: 'read' }, 'hosts', 'write')).toBe(false);
  });

  it('lets a custom scope do only what it lists, a write implying the read', () => {
    const scope = parseTokenScope('custom', ['hosts:write', 'audit:read']);
    expect(scopeAllows(scope, 'hosts', 'read')).toBe(true);
    expect(scopeAllows(scope, 'hosts', 'write')).toBe(true);
    expect(scopeAllows(scope, 'audit', 'read')).toBe(true);
    expect(scopeAllows(scope, 'audit', 'write')).toBe(false);
    expect(scopeAllows(scope, 'settings', 'read')).toBe(false);
  });
});

describe('the stored columns', () => {
  it('round-trip, and an unreadable list grants nothing', () => {
    const custom = parseTokenScope('custom', ['users:read']);
    const columns = scopeToColumns(custom);
    expect(scopeFromColumns(columns.scope, columns.permissions)).toEqual(custom);
    expect(scopeFromColumns('custom', '{not json')).toEqual({ kind: 'custom', permissions: [] });
    expect(scopeFromColumns('full', null)).toEqual(FULL_SCOPE);
  });

  it('flatten for the API and back', () => {
    expect(flattenScope({ kind: 'read' })).toEqual({ scope: 'read', permissions: [] });
    expect(unflattenScope({ scope: 'custom', permissions: ['tokens:write'] })).toEqual({
      kind: 'custom',
      permissions: ['tokens:write'],
    });
  });
});

describe('resolveTokenExpiry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('counts the presets from now, and never is no date', () => {
    expect(resolveTokenExpiry('30d', undefined, now)).toBe('2026-01-31T00:00:00.000Z');
    expect(resolveTokenExpiry('1y', undefined, now)).toBe('2027-01-01T00:00:00.000Z');
    expect(resolveTokenExpiry('never', '2030-01-01', now)).toBeUndefined();
    expect(resolveTokenExpiry('custom', '2030-01-01T00:00', now)).toBe('2030-01-01T00:00');
  });
});
