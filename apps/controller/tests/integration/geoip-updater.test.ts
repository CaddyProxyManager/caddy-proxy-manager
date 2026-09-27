/** Pins what gets downloaded: each download counts against the account's daily MaxMind limit. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from '@/tests/helpers/vi';
import { createTestDb, currentDb, type TestDb } from '@/tests/helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, pushes: 0 }));

const schemaModule = await import('@/src/lib/db/schema');

// A Bun mock factory must be synchronous; an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => ({
  default: currentDb(() => ctx.db),
  db: currentDb(() => ctx.db),
  client: undefined,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null =>
    !value ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
}));

vi.mock('@/src/lib/agent/fleet-config', () => ({
  currentFleetConfig: async () => ({ clickhouse: null, analytics: false, geoip: null }),
  pushFleetConfig: async () => {
    ctx.pushes += 1;
  },
}));

const registry = await import('@/src/lib/settings/registry');
const { saveSettings } = await import('@/src/lib/settings/resolve');
const { setSetting } = await import('@/src/lib/settings');
const { getGeoipDownloadState, updateGeoipDatabases } = await import('@/src/lib/geoip/updater');

const EDITIONS = ['GeoLite2-Country', 'GeoLite2-ASN', 'GeoLite2-City'] as const;

let dir: string;
let builds: Record<string, string>;
let metadataStatus: number;
let brokenEdition: string | null;
let downloads: string[];
let calls: number;

function mmdb(label: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(label),
      Buffer.from([0xab, 0xcd, 0xef]),
      Buffer.from('MaxMind.com'),
    ]),
  );
}

/** Metadata, a redirecting download, and the storage behind it. */
const fakeMaxMind = (async (input: string) => {
  calls += 1;
  const url = new URL(input);

  if (url.hostname === 'updates.maxmind.com') {
    const databases = url.searchParams
      .getAll('edition_id')
      .map((edition) => ({ edition_id: edition, date: builds[edition] }));
    return new Response(JSON.stringify({ databases }), { status: metadataStatus });
  }

  if (url.hostname === 'download.maxmind.com') {
    const edition = url.pathname.split('/')[3];
    return new Response(null, {
      status: 302,
      headers: { location: `https://storage.example/${edition}` },
    });
  }

  const edition = url.pathname.slice(1);
  downloads.push(edition);
  if (edition === brokenEdition) return new Response('<html>Service Unavailable</html>');
  const stamp = builds[edition].replaceAll('-', '');
  const archive = await new Bun.Archive(
    { [`${edition}_${stamp}/${edition}.mmdb`]: mmdb(`${edition} ${stamp}`) },
    { compress: 'gzip' },
  ).bytes();
  return new Response(archive);
}) as unknown as typeof fetch;

async function configure(values: { enabled?: boolean; accountId?: string; licenseKey?: string }) {
  await saveSettings({
    [registry.geoipEnabled.key]: values.enabled ?? true,
    [registry.geoipAccountId.key]: values.accountId ?? '12345',
    [registry.geoipLicenseKey.key]: values.licenseKey ?? 'licence',
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cpm-geoip-updater-'));
  process.env.GEOIP_DIR = dir;
  builds = {
    'GeoLite2-Country': '2026-09-08',
    'GeoLite2-ASN': '2026-09-08',
    'GeoLite2-City': '2026-09-08',
  };
  metadataStatus = 200;
  brokenEdition = null;
  downloads = [];
  calls = 0;
  ctx.pushes = 0;
  await setSetting('geoip_downloads', null);
  await configure({});
});

afterEach(() => {
  delete process.env.GEOIP_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('updateGeoipDatabases', () => {
  it('downloads every missing edition and tells the agents', async () => {
    const result = await updateGeoipDatabases(fakeMaxMind);

    expect(result).toEqual({
      downloaded: [...EDITIONS],
      error: null,
      checkError: null,
      failures: [],
    });
    for (const edition of EDITIONS) {
      expect(readFileSync(join(dir, `${edition}.mmdb`), 'latin1')).toStartWith(
        `${edition} 20260908`,
      );
    }
    expect((await getGeoipDownloadState()).builds).toEqual(builds);
    expect(ctx.pushes).toBe(1);
  });

  it('downloads nothing when every build on disk is current', async () => {
    await updateGeoipDatabases(fakeMaxMind);
    downloads = [];

    const result = await updateGeoipDatabases(fakeMaxMind);

    expect(result.downloaded).toEqual([]);
    expect(downloads).toEqual([]);
    expect(ctx.pushes).toBe(1);
  });

  it('downloads only the edition MaxMind rebuilt, even on the day of the last download', async () => {
    await updateGeoipDatabases(fakeMaxMind);
    downloads = [];
    builds['GeoLite2-Country'] = '2026-09-11';

    const result = await updateGeoipDatabases(fakeMaxMind);

    expect(result.downloaded).toEqual(['GeoLite2-Country']);
    expect(downloads).toEqual(['GeoLite2-Country']);
    expect((await getGeoipDownloadState()).builds['GeoLite2-Country']).toBe('2026-09-11');
  });

  it('keeps the databases it has when MaxMind cannot say whether they are current', async () => {
    await updateGeoipDatabases(fakeMaxMind);
    downloads = [];
    metadataStatus = 503;

    const result = await updateGeoipDatabases(fakeMaxMind);

    expect(result.downloaded).toEqual([]);
    expect(result.error).toContain('HTTP 503');
    expect(downloads).toEqual([]);
    // The check stores its own failure; the download state has nothing of its own to add.
    expect((await getGeoipDownloadState()).error).toBeNull();
  });

  it('records a download that failed without losing the others', async () => {
    brokenEdition = 'GeoLite2-ASN';

    const result = await updateGeoipDatabases(fakeMaxMind);

    expect(result.downloaded).toEqual(['GeoLite2-Country', 'GeoLite2-City']);
    expect(existsSync(join(dir, 'GeoLite2-ASN.mmdb'))).toBe(false);
    const state = await getGeoipDownloadState();
    expect(state.error).toContain('GeoLite2-ASN: the download is not a readable archive');
    expect(state.failures).toEqual([
      {
        edition: 'GeoLite2-ASN',
        message: 'the download is not a readable archive',
        code: { code: 'geoipArchiveUnreadable', params: {} },
      },
    ]);
    expect(state.builds['GeoLite2-ASN']).toBeUndefined();

    // Retried on the next run, since it is still missing.
    brokenEdition = null;
    expect((await updateGeoipDatabases(fakeMaxMind)).downloaded).toEqual(['GeoLite2-ASN']);
    expect((await getGeoipDownloadState()).error).toBeNull();
  });

  it('does not reach MaxMind while GeoIP is off', async () => {
    await configure({ enabled: false });

    expect(await updateGeoipDatabases(fakeMaxMind)).toEqual({
      downloaded: [],
      error: null,
      skipped: 'disabled',
    });
    expect(calls).toBe(0);
  });

  it('does not reach MaxMind without credentials', async () => {
    await configure({ accountId: '' });

    expect((await updateGeoipDatabases(fakeMaxMind)).skipped).toBe('unconfigured');
    expect(calls).toBe(0);
  });
});
