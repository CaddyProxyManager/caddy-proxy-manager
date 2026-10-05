import { describe, it, expect } from 'bun:test';
import { oauthCallbackErrorMessage } from '@/src/lib/auth/oauth-callback-error';

const t = (key: string, values?: Record<string, string>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

describe('oauthCallbackErrorMessage', () => {
  it('says nothing when there is no error', () => {
    expect(oauthCallbackErrorMessage(undefined, t)).toBeNull();
    expect(oauthCallbackErrorMessage('', t)).toBeNull();
  });

  it('explains a refused link, which replaced the /link-account page', () => {
    expect(oauthCallbackErrorMessage('account_not_linked', t)).toBe('accountNotLinked');
  });

  it('names any other Better Auth code', () => {
    expect(oauthCallbackErrorMessage('invalid_code', t)).toBe(
      'oauthFailedCode:{"code":"invalid_code"}',
    );
  });

  it('never echoes text that is not shaped like a code', () => {
    expect(oauthCallbackErrorMessage('<b>Your account is locked, call 555</b>', t)).toBe(
      'oauthFailedCode:{"code":"unknown"}',
    );
  });
});
