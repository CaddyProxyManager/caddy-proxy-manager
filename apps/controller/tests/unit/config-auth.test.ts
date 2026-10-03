import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { readConfig } from '@/src/lib/config';

async function loadAllowSelfRegistration(value?: string): Promise<boolean> {
  if (value === undefined) {
    vi.stubEnv('AUTH_ALLOW_SELF_REGISTRATION', undefined);
  } else {
    vi.stubEnv('AUTH_ALLOW_SELF_REGISTRATION', value);
  }

  const { config } = readConfig();
  return config.auth.allowSelfRegistration;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('email self-registration configuration', () => {
  it('is disabled when AUTH_ALLOW_SELF_REGISTRATION is unset', async () => {
    expect(await loadAllowSelfRegistration()).toBe(false);
  });

  it('is enabled only when AUTH_ALLOW_SELF_REGISTRATION is exactly true', async () => {
    expect(await loadAllowSelfRegistration('true')).toBe(true);
    expect(await loadAllowSelfRegistration('false')).toBe(false);
    expect(await loadAllowSelfRegistration('TRUE')).toBe(false);
  });
});
