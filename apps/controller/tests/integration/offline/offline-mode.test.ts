/**
 * Offline mode on: every internet call the registry lists is skipped without touching the network,
 * the agents are told not to build Caddy, and the outbound connections page says so. Off, each
 * call runs again, so the switch is the only thing in the way.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

// A Bun mock factory must be synchronous; an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));

const registry = await import('@/src/lib/settings/registry');
const { invalidateSettingsCache, saveSettings } = await import('@/src/lib/settings/resolve');
const { isGravatarEnabled } = await import('@/src/lib/settings');
const { OUTBOUND_CALL_IDS, OUTBOUND_CALLS, outboundAllowed, outboundCallViews } = await import(
  '@/src/lib/offline'
);
const { checkForUpdates, getUpdateStatus } = await import('@/src/lib/runtime/updates');
const { askLetsDebug } = await import('@/src/lib/reachability/letsdebug');
const { refreshCrsRegistryLists, syncCrsRegistryIfDue } = await import(
  '@/src/lib/waf/crs-plugins/sync'
);
const { checkGeoipUpdates } = await import('@/src/lib/geoip/update-check');
const { updateGeoipDatabases } = await import('@/src/lib/geoip/updater');
const { sendPush, setPushDeliveryForTests } = await import('@/src/lib/notifications/push');
const { currentFleetConfig } = await import('@/src/lib/agent/fleet-config');

const realFetch = globalThis.fetch;
let requested: string[] = [];

async function offline(on: boolean): Promise<void> {
  await saveSettings({
    [registry.offlineMode.key]: on,
    [registry.geoipEnabled.key]: true,
    [registry.geoipAccountId.key]: '12345',
    [registry.geoipLicenseKey.key]: 'licence',
  });
  invalidateSettingsCache();
}

/** Every request any of these calls makes, answered with an error so nothing waits. */
const recorder = (async (input: string | URL | Request) => {
  requested.push(String(input instanceof Request ? input.url : input));
  return new Response('nope', { status: 503 });
}) as unknown as typeof fetch;

beforeEach(() => {
  requested = [];
  globalThis.fetch = recorder;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setPushDeliveryForTests(null);
});

describe('offline mode on', () => {
  beforeEach(() => offline(true));

  it('refuses every internet call and allows the rest', async () => {
    for (const id of OUTBOUND_CALL_IDS) {
      expect(await outboundAllowed(id), id).toBe(OUTBOUND_CALLS[id] !== 'internet');
    }
  });

  it('skips the update check, and reports it as off', async () => {
    const result = await checkForUpdates();
    expect(result.errorCode).toEqual({ code: 'outboundOffline', params: {} });
    expect((await getUpdateStatus()).enabled).toBe(false);
    expect(requested).toEqual([]);
  });

  it("does not ask Let's Debug", async () => {
    expect(await askLetsDebug('example.com')).toEqual({ state: 'offline' });
    expect(requested).toEqual([]);
  });

  it('hides Gravatar', async () => {
    expect(await isGravatarEnabled()).toBe(false);
  });

  it('reads no CRS plugin registry, and schedules no pass', async () => {
    const state = await refreshCrsRegistryLists(recorder);
    expect(Object.values(state.sources).map((source) => source.error?.code)).toContainEqual({
      code: 'outboundOffline',
      params: {},
    });
    expect(await syncCrsRegistryIfDue({ fetcher: recorder })).toBe(false);
    expect(requested).toEqual([]);
  });

  it('neither checks nor downloads MaxMind databases', async () => {
    expect(await updateGeoipDatabases(recorder)).toMatchObject({ skipped: 'offline' });
    expect((await checkGeoipUpdates(['GeoLite2-Country'], recorder)).errorCode).toEqual({
      code: 'outboundOffline',
      params: {},
    });
    expect(requested).toEqual([]);
  });

  it('sends no browser push', async () => {
    const delivered: string[] = [];
    setPushDeliveryForTests(async (target) => {
      delivered.push(target.endpoint);
    });
    const notice = { id: 'n1', key: 'k', at: new Date().toISOString(), event: {} };
    const target = {
      userId: 1,
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
      locale: null,
    };
    expect(await sendPush([notice as any], [target])).toEqual({ delivered: 0, failed: 0 });
    expect(delivered).toEqual([]);
  });

  it('tells the agents not to build Caddy', async () => {
    expect((await currentFleetConfig()).offline).toBe(true);
  });

  it('shows every internet call as off on the outbound connections page', async () => {
    const views = await outboundCallViews();
    expect(views.map((view) => view.id)).toEqual(OUTBOUND_CALL_IDS);
    for (const view of views) {
      expect(view.state, view.id).toBe(view.kind === 'internet' ? 'offline' : view.kind);
    }
  });
});

describe('offline mode off', () => {
  beforeEach(() => offline(false));

  it('lets the same calls through', async () => {
    await checkForUpdates();
    await askLetsDebug('example.com');
    await updateGeoipDatabases(recorder);
    expect(requested.some((url) => url.includes('letsdebug.net'))).toBe(true);
    expect(requested.some((url) => url.includes('maxmind.com'))).toBe(true);
    expect(requested.length).toBeGreaterThanOrEqual(3);
    expect(await isGravatarEnabled()).toBe(true);
    expect((await currentFleetConfig()).offline).toBe(false);
  });

  it('shows an internet call by its own switch', async () => {
    await saveSettings({ [registry.updateCheckEnabled.key]: false });
    invalidateSettingsCache();
    const views = new Map((await outboundCallViews()).map((view) => [view.id, view.state]));
    expect(views.get('updateCheck')).toBe('switchedOff');
    expect(views.get('maxmind')).toBe('on');
    expect(views.get('ldap')).toBe('configured');
    expect(views.get('caddyAdmin')).toBe('internal');
    await saveSettings({ [registry.updateCheckEnabled.key]: true });
  });
});
