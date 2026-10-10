/**
 * The sign-up form shows Better Auth's refusals from `auth.errors`, looked up by code, except the
 * password policy's, which the server words in the reader's language and marks with its own code.
 */
import { describe, expect, it } from 'bun:test';
import messages from '../../../messages/en.json';
import { PASSWORD_POLICY_CODE } from '@/src/lib/auth/signup-policy';
import { SIGN_UP_ERROR_KEYS, signUpErrorMessage } from '@/src/lib/auth/sign-up-error';

const errors = messages.auth.errors as Record<string, string | undefined>;
const t = (key: string) => key;

describe('signUpErrorMessage', () => {
  it('maps each code it knows to its message', () => {
    for (const [code, key] of Object.entries(SIGN_UP_ERROR_KEYS)) {
      expect(signUpErrorMessage({ status: 400, code }, t)).toBe(key);
    }
    expect(signUpErrorMessage({ status: 400, code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' }, t)).toBe(
      'signUpDisabled',
    );
    expect(
      signUpErrorMessage({ status: 422, code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }, t),
    ).toBe('emailTaken');
  });

  it('shows the policy refusal as the server worded it', () => {
    expect(
      signUpErrorMessage(
        { status: 400, code: PASSWORD_POLICY_CODE, message: 'Password must include a number' },
        t,
      ),
    ).toBe('Password must include a number');
    // Without its sentence the code is no better than any other unknown one.
    expect(signUpErrorMessage({ status: 400, code: PASSWORD_POLICY_CODE }, t)).toBe('signUpFailed');
  });

  it('recognises the rate limiter by status, since its answer carries no code', () => {
    expect(signUpErrorMessage({ status: 429 }, t)).toBe('tooManyRequests');
  });

  it('never falls through to raw text for a code it does not know', () => {
    expect(
      signUpErrorMessage({ status: 400, code: 'FAILED_TO_CREATE_USER', message: 'x' }, t),
    ).toBe('signUpFailed');
    expect(signUpErrorMessage({ status: 500 }, t)).toBe('signUpFailed');
    expect(signUpErrorMessage({ code: 'toString' }, t)).toBe('signUpFailed');
  });

  it('has a sentence in the catalog for every key', () => {
    const keys = [...new Set(Object.values(SIGN_UP_ERROR_KEYS)), 'signUpFailed', 'tooManyRequests'];
    for (const key of keys) expect(errors[key]).toBeString();
  });
});
