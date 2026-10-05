/** Account rules the Users page, `/api/v1/users` and GraphQL share, pinned once for all three. */
import { describe, expect, it } from 'bun:test';
import { DomainError } from '@/src/lib/errors/domain-error';
import {
  assertAcceptablePassword,
  assertEmailAddress,
  assertNotSelf,
  assertUserRole,
  assertUserStatus,
  isUserRole,
  isUserStatus,
} from '@/src/lib/users/admin';

describe('roles an administrator may assign', () => {
  it('accepts every application role, operator included', () => {
    for (const role of ['admin', 'operator', 'user', 'viewer']) {
      expect(isUserRole(role), role).toBe(true);
    }
  });

  it('refuses anything else, near misses included', () => {
    for (const role of ['superadmin', 'Admin', ' admin', '', null, undefined, 1]) {
      expect(isUserRole(role), String(role)).toBe(false);
    }
    expect(() => assertUserRole('root')).toThrow(DomainError);
  });
});

describe('account statuses', () => {
  it('accepts active and disabled only', () => {
    expect(isUserStatus('active')).toBe(true);
    expect(isUserStatus('disabled')).toBe(true);
    expect(isUserStatus('banned')).toBe(false);
    expect(() => assertUserStatus('pending')).toThrow(DomainError);
  });
});

describe('acting on your own account', () => {
  it('is refused with the code the caller names', () => {
    expect(() => assertNotSelf(3, 3, 'cannotDeleteOwnAccount')).toThrow(
      'Cannot delete your own account',
    );
    expect(() => assertNotSelf(3, 4, 'cannotDeleteOwnAccount')).not.toThrow();
  });
});

describe('an address an administrator types', () => {
  it('is refused when it cannot be an email address', () => {
    expect(() => assertEmailAddress('not-an-email')).toThrow(DomainError);
    expect(() => assertEmailAddress('name@example..com')).toThrow(DomainError);
  });

  it('accepts the dotless address setup gives the first administrator', () => {
    expect(() => assertEmailAddress('admin@localhost')).not.toThrow();
    expect(() => assertEmailAddress('new@example.com')).not.toThrow();
  });
});

describe('a password chosen for someone else', () => {
  it('is held to the password policy', () => {
    expect(() => assertAcceptablePassword('password')).toThrow(/at least 12 characters/);
    expect(() => assertAcceptablePassword('CorrectHorse2026!')).not.toThrow();
  });
});
