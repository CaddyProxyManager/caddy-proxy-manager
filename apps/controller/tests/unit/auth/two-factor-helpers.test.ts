import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { createTestDb } from '@/tests/helpers/db';
import { dbModuleMock } from '@/tests/helpers/db-module';

// A challenge counts its attempts where every replica sees them.
const testDb = await createTestDb();
vi.mock('@/src/lib/db', () => dbModuleMock(() => testDb));
import {
  CONSOLE_COMMAND_MAX_AGE_MS,
  isLoopbackAddress,
  signConsoleCommand,
  verifyConsoleCommand,
} from '../../../src/lib/users/console-command';
import {
  PORTAL_CHALLENGE_ATTEMPTS,
  PORTAL_CHALLENGE_TTL_MS,
  issuePortalChallenge,
  redeemPortalChallenge,
  spendPortalChallenge,
} from '../../../src/lib/forward-auth/portal-two-factor';
import { twoFactorError } from '../../../src/lib/auth/two-factor/error';
import { hasTwoFactorChallengeCookie } from '../../../src/lib/auth/sign-in-paths';

describe('console commands', () => {
  const secret = 'a'.repeat(64);

  it('accepts its own signature and nothing altered', () => {
    const timestamp = Date.now();
    const signature = signConsoleCommand(secret, 'admin', timestamp);
    expect(verifyConsoleCommand(secret, { username: 'admin', timestamp, signature })).toBe('admin');
    expect(verifyConsoleCommand(secret, { username: 'alice', timestamp, signature })).toBeNull();
    expect(
      verifyConsoleCommand('b'.repeat(64), { username: 'admin', timestamp, signature }),
    ).toBeNull();
  });

  it('refuses one command signed for the other', () => {
    const timestamp = Date.now();
    const reset = signConsoleCommand(secret, 'admin', timestamp);
    const enable = signConsoleCommand(secret, 'admin', timestamp, 'enable-user');
    const body = (signature: string) => ({ username: 'admin', timestamp, signature });
    expect(verifyConsoleCommand(secret, body(enable), timestamp, 'enable-user')).toBe('admin');
    expect(verifyConsoleCommand(secret, body(reset), timestamp, 'enable-user')).toBeNull();
    expect(verifyConsoleCommand(secret, body(enable), timestamp)).toBeNull();
  });

  it('refuses a stale command', () => {
    const timestamp = Date.now() - CONSOLE_COMMAND_MAX_AGE_MS - 1;
    const signature = signConsoleCommand(secret, 'admin', timestamp);
    expect(verifyConsoleCommand(secret, { username: 'admin', timestamp, signature })).toBeNull();
  });

  it('knows loopback in every spelling, and nothing else', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
    for (const address of [
      '10.0.0.1',
      '172.18.0.3',
      '::ffff:10.0.0.1',
      '',
      null,
      '127.0.0.1.evil',
    ]) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });
});

describe('portal challenge', () => {
  it('redeems for the intent it was issued for, a limited number of times', async () => {
    const challenge = issuePortalChallenge(7, 'rid-a');
    expect(await redeemPortalChallenge(challenge, 'rid-b')).toBeNull();
    for (let i = 0; i < PORTAL_CHALLENGE_ATTEMPTS; i++) {
      expect((await redeemPortalChallenge(challenge, 'rid-a'))?.userId).toBe(7);
    }
    expect(await redeemPortalChallenge(challenge, 'rid-a')).toBeNull();
  });

  it('is finished once spent', async () => {
    const challenge = issuePortalChallenge(7, 'rid-c');
    const redeemed = await redeemPortalChallenge(challenge, 'rid-c');
    await spendPortalChallenge(redeemed?.nonce ?? '');
    expect(await redeemPortalChallenge(challenge, 'rid-c')).toBeNull();
  });

  it('expires, and refuses a forged user id', async () => {
    const past = Date.now() - PORTAL_CHALLENGE_TTL_MS - 1;
    expect(await redeemPortalChallenge(issuePortalChallenge(7, 'rid-d', past), 'rid-d')).toBeNull();
    const forged = issuePortalChallenge(7, 'rid-e').replace(/^7\./, '1.');
    expect(await redeemPortalChallenge(forged, 'rid-e')).toBeNull();
  });
});

describe('two-factor errors', () => {
  it('sends a spent challenge back to the password, and keeps a wrong code on the code step', () => {
    expect(twoFactorError({ code: 'INVALID_CODE' })).toEqual({
      key: 'invalidSecondFactor',
      restart: false,
    });
    expect(twoFactorError({ code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' }).restart).toBe(true);
    expect(twoFactorError({ code: 'CHALLENGE_EXPIRED' }).restart).toBe(true);
    expect(twoFactorError({ code: 'ACCOUNT_TEMPORARILY_LOCKED' }).key).toBe('secondFactorLocked');
  });

  it("tells a sign-in's code from confirming a new authenticator by the plugin's cookie", () => {
    expect(hasTwoFactorChallengeCookie('better-auth.two_factor=abc')).toBe(true);
    expect(hasTwoFactorChallengeCookie('x=1; __Secure-better-auth.two_factor=abc')).toBe(true);
    expect(hasTwoFactorChallengeCookie('better-auth.session_token=abc')).toBe(false);
    expect(hasTwoFactorChallengeCookie(null)).toBe(false);
  });
});
