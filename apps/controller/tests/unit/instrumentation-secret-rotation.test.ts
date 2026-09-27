/**
 * The startup secret passes in instrumentation.ts: where they run relative to what reads the
 * secrets, and what they log.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  reencryptStoredSecrets: vi.fn(),
  purgeForced: [] as boolean[],
}));

function step<T>(name: string, value?: T) {
  return async () => {
    mocks.order.push(name);
    return value;
  };
}

const actualConfig = await import('../../src/lib/config');

vi.mock('../../src/lib/runtime-guard', () => ({ assertBunRuntime: () => {} }));
vi.mock('../../src/lib/config', () => ({ ...actualConfig, validateProductionConfig: () => {} }));
vi.mock('../../src/lib/demo-mode', () => ({ isDemoMode: () => false }));
vi.mock('../../src/lib/init-db', () => ({ ensureAdminUser: step('ensureAdminUser') }));
vi.mock('../../src/lib/setup', () => ({ backfillSetupCompletion: step('backfillSetup') }));
vi.mock('../../src/lib/models/certificates', () => ({
  migrateLegacyCertificateStorage: step('certificates', 0),
}));
vi.mock('../../src/lib/models/ca-certificates', () => ({
  migrateLegacyCaCertificateStorage: step('caCertificates', 0),
}));
vi.mock('../../src/lib/settings/plaintext-credentials', () => ({
  encryptPlaintextDnsCredentials: step('plaintextDns', 0),
}));
vi.mock('../../src/lib/secret-rotation', () => ({
  reencryptStoredSecrets: async () => {
    mocks.order.push('rotation');
    return mocks.reencryptStoredSecrets();
  },
}));
vi.mock('../../src/lib/db/connection', () => ({
  purgeDeletedDatabaseContent: (force: boolean) => {
    mocks.order.push('purge');
    mocks.purgeForced.push(force);
    return false;
  },
}));
vi.mock('../../src/lib/caddy', () => ({ applyCaddyConfig: step('applyCaddyConfig') }));
vi.mock('../../src/lib/caddy-monitor', () => ({
  noteStartupApply: () => {},
  startCaddyMonitoring: () => {},
}));
vi.mock('../../src/lib/clickhouse/client', () => ({
  initClickHouse: async () => {},
  closeClickHouse: () => {},
}));
vi.mock('../../src/lib/agent/bootstrap', () => ({ ensureBootstrapToken: async () => {} }));
vi.mock('../../src/lib/agent/fleet-config', () => ({ pushFleetConfig: async () => {} }));
vi.mock('../../src/lib/agent/managed-services', () => ({ applyManagedServices: async () => {} }));
vi.mock('../../src/lib/geoip/updater', () => ({ startGeoipUpdater: () => {} }));
vi.mock('../../src/lib/crs-plugins/sync', () => ({ startCrsRegistryUpdater: () => {} }));
vi.mock('../../src/lib/models/crs-plugins', () => ({
  installedCrsPluginRepositories: [],
  assertCrsPluginIdsExist: async () => {},
}));

import { register } from '../../src/instrumentation';

const sigtermBefore = process.listeners('SIGTERM');

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
}

async function run(result: { reencrypted: number; failed: number; clearedOAuthTokens: number }) {
  mocks.reencryptStoredSecrets.mockResolvedValue(result);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await register();
  return { log: logged(log), warn: logged(warn) };
}

beforeEach(() => {
  mocks.order.length = 0;
  mocks.purgeForced.length = 0;
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const listener of process.listeners('SIGTERM')) {
    if (!sigtermBefore.includes(listener)) process.off('SIGTERM', listener);
  }
});

describe('startup secret passes', () => {
  it('run after the certificate migrations and before the Caddy config is built', async () => {
    await run({ reencrypted: 0, failed: 0, clearedOAuthTokens: 0 });
    const at = (name: string) => mocks.order.indexOf(name);
    expect(at('rotation')).toBeGreaterThan(at('caCertificates'));
    expect(at('rotation')).toBeGreaterThan(at('plaintextDns'));
    expect(at('rotation')).toBeLessThan(at('applyCaddyConfig'));
    expect(at('purge')).toBeGreaterThan(at('rotation'));
    expect(at('purge')).toBeLessThan(at('applyCaddyConfig'));
    // Nothing was rewritten, so only the once-per-database vacuum may run.
    expect(mocks.purgeForced).toEqual([false]);
  });

  it('forces the vacuum when a pass rewrote secrets', async () => {
    await run({ reencrypted: 0, failed: 0, clearedOAuthTokens: 2 });
    expect(mocks.purgeForced).toEqual([true]);
  });

  it('summarizes cleared OAuth tokens in one informational line, not as failures', async () => {
    const { log, warn } = await run({ reencrypted: 0, failed: 0, clearedOAuthTokens: 600 });
    expect(log).toContain('Cleared 600 stored OAuth token(s)');
    expect(warn).not.toMatch(/stored secret|re-enter/);
  });

  it('points to the recovery steps for values no key decrypts', async () => {
    const { log, warn } = await run({ reencrypted: 1, failed: 2, clearedOAuthTokens: 0 });
    expect(log).toContain('Re-encrypted 1 stored secret(s)');
    expect(log).not.toContain('OAuth');
    expect(warn).toContain('2 stored secret(s) listed above could not be decrypted');
    expect(warn).toContain('SESSION_SECRET_PREVIOUS');
  });

  it('starts the app when the pass throws', async () => {
    mocks.reencryptStoredSecrets.mockRejectedValue(new Error('database is locked'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await register();
    expect(logged(error)).toContain('Failed to re-encrypt stored secrets');
    expect(mocks.order).toContain('applyCaddyConfig');
  });
});
