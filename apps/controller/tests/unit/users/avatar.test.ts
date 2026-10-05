/**
 * User icon resolution: own icon, then Gravatar, then initial. The interesting rule is which
 * addresses get a Gravatar - a synthetic `<username>@localhost` would leak the username.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import {
  avatarInitial,
  gravatarUrl,
  isNonRoutableEmail,
  resolveAvatar,
} from '../../../src/lib/users/avatar';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('isNonRoutableEmail', () => {
  it('accepts a real address', () => {
    expect(isNonRoutableEmail('someone@example.com')).toBe(false);
    expect(isNonRoutableEmail('someone@mail.example.co.uk')).toBe(false);
  });

  it('rejects the synthetic address local accounts are created with', () => {
    expect(isNonRoutableEmail('admin@localhost')).toBe(true);
  });

  it('rejects reserved special-use domains, including as a suffix', () => {
    expect(isNonRoutableEmail('a@box.local')).toBe(true);
    expect(isNonRoutableEmail('a@thing.internal')).toBe(true);
    expect(isNonRoutableEmail('a@home.arpa')).toBe(true);
    expect(isNonRoutableEmail('a@whatever.invalid')).toBe(true);
  });

  it('rejects a bare hostname with no dot', () => {
    expect(isNonRoutableEmail('admin@server')).toBe(true);
  });

  it('rejects anything that is not an address at all', () => {
    expect(isNonRoutableEmail(null)).toBe(true);
    expect(isNonRoutableEmail(undefined)).toBe(true);
    expect(isNonRoutableEmail('   ')).toBe(true);
    expect(isNonRoutableEmail('not-an-email')).toBe(true);
    expect(isNonRoutableEmail('trailing@')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isNonRoutableEmail('  Admin@LOCALHOST  ')).toBe(true);
    expect(isNonRoutableEmail('  Someone@Example.COM  ')).toBe(false);
  });
});

describe('gravatarUrl', () => {
  it('hashes the normalised address with SHA-256', () => {
    const url = gravatarUrl('Someone@Example.COM');
    expect(url).toContain(`/avatar/${sha256('someone@example.com')}`);
  });

  it('trims before hashing, so padding does not change the identity', () => {
    expect(gravatarUrl('  someone@example.com  ')).toBe(gravatarUrl('someone@example.com'));
  });

  it('asks for a 404 rather than a generated placeholder', () => {
    // Without d=404 Gravatar invents a design, and the initial would never show.
    expect(gravatarUrl('someone@example.com')).toContain('d=404');
  });

  it('requests the size it was given', () => {
    expect(gravatarUrl('someone@example.com', 72)).toContain('s=72');
  });

  it('returns nothing for an address that cannot have a Gravatar', () => {
    expect(gravatarUrl('admin@localhost')).toBeNull();
    expect(gravatarUrl(null)).toBeNull();
    expect(gravatarUrl('')).toBeNull();
  });
});

describe('avatarInitial', () => {
  it('prefers the name over the email', () => {
    expect(avatarInitial({ name: 'Ada Lovelace', email: 'zed@example.com' })).toBe('A');
  });

  it('falls back to the email when there is no name', () => {
    expect(avatarInitial({ name: null, email: 'zed@example.com' })).toBe('Z');
  });

  it('skips leading punctuation to find a real character', () => {
    expect(avatarInitial({ name: '  "quoted"', email: 'a@example.com' })).toBe('Q');
  });

  it('handles a non-Latin name', () => {
    expect(avatarInitial({ name: 'Ирина', email: 'a@example.com' })).toBe('И');
  });

  it('falls back to U when there is nothing usable', () => {
    expect(avatarInitial({ name: null, email: null })).toBe('U');
    expect(avatarInitial({ name: '---', email: '' })).toBe('U');
  });
});

describe('resolveAvatar', () => {
  it('keeps a custom icon and still offers the Gravatar behind it', () => {
    const resolved = resolveAvatar({
      name: 'Ada',
      email: 'ada@example.com',
      avatarUrl: 'data:image/png;base64,AAAA',
    });
    expect(resolved.imageUrl).toBe('data:image/png;base64,AAAA');
    // Resolved regardless, so a broken or blocked icon still steps down.
    expect(resolved.gravatarUrl).toContain('/avatar/');
    expect(resolved.initial).toBe('A');
  });

  it('falls back to the Gravatar when no icon is set', () => {
    const resolved = resolveAvatar({ name: 'Ada', email: 'ada@example.com', avatarUrl: null });
    expect(resolved.imageUrl).toBeNull();
    expect(resolved.gravatarUrl).toContain(`/avatar/${sha256('ada@example.com')}`);
  });

  it('leaves a local account with only its initial', () => {
    const resolved = resolveAvatar({ name: 'Admin', email: 'admin@localhost', avatarUrl: null });
    expect(resolved.imageUrl).toBeNull();
    expect(resolved.gravatarUrl).toBeNull();
    expect(resolved.initial).toBe('A');
  });

  it('treats a blank icon as no icon', () => {
    expect(resolveAvatar({ email: 'a@example.com', avatarUrl: '   ' }).imageUrl).toBeNull();
  });

  it('passes the requested size through to the Gravatar', () => {
    expect(resolveAvatar({ email: 'a@example.com' }, 72).gravatarUrl).toContain('s=72');
  });
});
