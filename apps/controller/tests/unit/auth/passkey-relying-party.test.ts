/** Which relying party a passkey is made for and which origins may use it; and the UV check. */
import { describe, expect, it } from 'bun:test';
import { isUserVerified, passkeyOrigins, passkeyRpId } from '@/src/lib/auth/passkeys/relying-party';
import { passkeyError } from '@/src/lib/auth/passkeys/error';
import { FRESH_SESSION_MAX_AGE_MS, isFreshSession } from '@/src/lib/auth/session-age';

describe('passkeyRpId', () => {
  it('is the Public URL hostname, without port or path', () => {
    expect(passkeyRpId('https://proxy.example.com:8443/cpm')).toBe('proxy.example.com');
    expect(passkeyRpId('http://localhost:3000')).toBe('localhost');
  });

  it('is null for an unparseable URL, never a default a browser would sign for', () => {
    expect(passkeyRpId('not a url')).toBeNull();
  });
});

describe('passkeyOrigins', () => {
  it('keeps the public origins on the rpID or below it', () => {
    expect(
      passkeyOrigins('example.com', [
        'https://example.com',
        'https://proxy.example.com',
        'http://192.168.1.5:3000',
        'https://notexample.com',
        'https://example.com.evil.net',
      ]),
    ).toEqual(['https://example.com', 'https://proxy.example.com']);
  });

  it('drops what does not parse', () => {
    expect(passkeyOrigins('localhost', ['http://localhost:3000', '::'])).toEqual([
      'http://localhost:3000',
    ]);
  });
});

describe('isUserVerified', () => {
  it('reads the UV flag of an assertion or a registration', () => {
    expect(isUserVerified({ authenticationInfo: { userVerified: true } })).toBe(true);
    expect(isUserVerified({ authenticationInfo: { userVerified: false } })).toBe(false);
    expect(isUserVerified({ registrationInfo: { userVerified: true } })).toBe(true);
    expect(isUserVerified({ registrationInfo: { userVerified: false } })).toBe(false);
  });

  it('fails closed when the flag is missing', () => {
    expect(isUserVerified({ authenticationInfo: {} })).toBe(false);
    expect(isUserVerified({ registrationInfo: undefined })).toBe(false);
  });
});

describe('registration freshness', () => {
  it("is ten minutes, far short of Better Auth's one day", () => {
    const now = Date.now();
    expect(FRESH_SESSION_MAX_AGE_MS).toBe(10 * 60 * 1000);
    expect(isFreshSession({ createdAt: new Date(now - 9 * 60 * 1000) }, now)).toBe(true);
    expect(isFreshSession({ createdAt: new Date(now - 11 * 60 * 1000) }, now)).toBe(false);
  });
});

describe('passkeyError', () => {
  it('says nothing when the prompt was cancelled', () => {
    expect(passkeyError({ code: 'AUTH_CANCELLED' }, 'signIn')).toBeNull();
    expect(passkeyError({ code: 'ERROR_CEREMONY_ABORTED' }, 'register')).toBeNull();
  });

  it("passes CPM's own refusals through, already translated", () => {
    expect(
      passkeyError({ code: 'USER_NOT_VERIFIED', message: 'translated', status: 400 }, 'signIn'),
    ).toEqual({ message: 'translated' });
  });

  it("maps the plugin's English by code", () => {
    expect(
      passkeyError({ code: 'PASSKEY_NOT_FOUND', message: 'Passkey not found' }, 'signIn'),
    ).toEqual({ key: 'passkeyUnknown' });
    expect(passkeyError({ code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' }, 'register')).toEqual(
      {
        key: 'passkeyAlreadyRegistered',
      },
    );
    expect(passkeyError({ status: 429 }, 'signIn')).toEqual({ key: 'passkeyTooManyAttempts' });
    expect(passkeyError({ code: 'SOMETHING_ELSE', message: 'English' }, 'register')).toEqual({
      key: 'passkeyAddFailed',
    });
  });
});
