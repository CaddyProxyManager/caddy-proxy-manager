import { describe, expect, it } from 'bun:test';
import { SETTINGS_GROUPS } from '@/src/lib/settings-api';
import { validateSettingsGroup } from '@/src/lib/settings-validation';

describe('REST settings groups', () => {
  // A handler with no validator case is unreachable: every PUT is refused as an unknown group.
  it.each(SETTINGS_GROUPS)('%s has a validator case', (group) => {
    let message = '';
    try {
      validateSettingsGroup(group, {});
    } catch (error) {
      // default-response throws a class of its own; only the unknown-group refusal matters here.
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('Unknown settings group');
  });

  it('checks the new groups for shape', () => {
    expect(() => validateSettingsGroup('http-protocols', { http2: true, http3: 'no' })).toThrow();
    expect(() =>
      validateSettingsGroup('two-factor', { requireForAdmins: true, extra: 1 }),
    ).toThrow();
    expect(() => validateSettingsGroup('global-caddy-config', { caddyfile: 42 })).toThrow();
    expect(validateSettingsGroup('global-caddy-config', { caddyfile: '' })).toEqual({
      caddyfile: '',
    });
  });
});
