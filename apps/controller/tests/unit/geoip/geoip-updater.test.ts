/** Pins the handling of a third party's answers. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractGeoipDatabase,
  fetchGeoipArchive,
  geoipUpdateDue,
  installGeoipDatabase,
  looksLikeMmdb,
  readCapped,
} from '../../../src/lib/geoip/updater';

/** Bytes ending in the marker every MaxMind database carries before its metadata. */
function fakeMmdb(body = 'search tree'): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(body),
      Buffer.from([0xab, 0xcd, 0xef]),
      Buffer.from('MaxMind.com'),
      Buffer.from('metadata'),
    ]),
  );
}

async function tarGz(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  return new Bun.Archive(files, { compress: 'gzip' }).bytes();
}

function streamOf(bytes: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
  );
}

describe('fetchGeoipArchive', () => {
  it('authenticates to MaxMind but not to the storage it redirects to', async () => {
    const seen: { url: string; auth: string | null; redirect?: RequestRedirect }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      seen.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        redirect: init.redirect,
      });
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://storage.example/GeoLite2-ASN.tar.gz?signature=x' },
        });
      }
      return new Response('archive bytes');
    }) as unknown as typeof fetch;

    const bytes = await fetchGeoipArchive('GeoLite2-ASN', '12345', 'key', fetchImpl);

    expect(new TextDecoder().decode(bytes)).toBe('archive bytes');
    expect(seen[0]).toEqual({
      url: 'https://download.maxmind.com/geoip/databases/GeoLite2-ASN/download?suffix=tar.gz',
      auth: `Basic ${Buffer.from('12345:key').toString('base64')}`,
      redirect: 'manual',
    });
    // Presigned storage refuses a request carrying a second credential.
    expect(seen[1].url).toBe('https://storage.example/GeoLite2-ASN.tar.gz?signature=x');
    expect(seen[1].auth).toBeNull();
  });

  it('names bad credentials specifically, since that is the common failure', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(fetchGeoipArchive('GeoLite2-ASN', 'a', 'b', fetchImpl)).rejects.toThrow(
      /rejected the account ID or licence key/,
    );
  });

  it('reports any other HTTP status, including from the storage it was redirected to', async () => {
    let calls = 0;
    const fetchImpl = (async () =>
      ++calls === 1
        ? new Response(null, { status: 302, headers: { location: '/elsewhere' } })
        : new Response('', { status: 403 })) as unknown as typeof fetch;

    await expect(fetchGeoipArchive('GeoLite2-ASN', 'a', 'b', fetchImpl)).rejects.toThrow(
      /HTTP 403/,
    );
  });

  it('refuses a redirect with nowhere to go', async () => {
    const fetchImpl = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    await expect(fetchGeoipArchive('GeoLite2-ASN', 'a', 'b', fetchImpl)).rejects.toThrow(
      /redirected/,
    );
  });
});

describe('readCapped', () => {
  it('returns the whole body under the limit', async () => {
    expect((await readCapped(streamOf(10), 10)).byteLength).toBe(10);
  });

  it('stops reading a body that runs past the limit', async () => {
    await expect(readCapped(streamOf(11), 10)).rejects.toThrow(/exceeded the 10-byte limit/);
  });
});

describe('extractGeoipDatabase', () => {
  it('returns the database and the build date its directory is named for', async () => {
    const database = fakeMmdb('country data');
    const archive = await tarGz({
      'GeoLite2-Country_20260912/GeoLite2-Country.mmdb': database,
      'GeoLite2-Country_20260912/LICENSE.txt': 'licence',
      'GeoLite2-Country_20260912/COPYRIGHT.txt': 'copyright',
    });

    const { bytes, build } = await extractGeoipDatabase(archive, 'GeoLite2-Country');

    expect(Buffer.from(bytes).equals(Buffer.from(database))).toBe(true);
    expect(build).toBe('2026-09-12');
  });

  it('does not take another edition for the one asked for', async () => {
    const archive = await tarGz({ 'GeoLite2-ASN_20260912/GeoLite2-ASN.mmdb': fakeMmdb() });
    await expect(extractGeoipDatabase(archive, 'GeoLite2-Country')).rejects.toThrow(
      /no GeoLite2-Country\.mmdb/,
    );
  });

  it('refuses a file that is not a MaxMind database', async () => {
    const archive = await tarGz({
      'GeoLite2-Country_20260912/GeoLite2-Country.mmdb': '<html>Service Unavailable</html>',
    });
    await expect(extractGeoipDatabase(archive, 'GeoLite2-Country')).rejects.toThrow(
      /not a database/,
    );
  });

  it('refuses a download that is not an archive at all', async () => {
    await expect(
      extractGeoipDatabase(new TextEncoder().encode('<html>error</html>'), 'GeoLite2-Country'),
    ).rejects.toThrow(/not a readable archive/);
  });
});

describe('looksLikeMmdb', () => {
  it('only looks for the marker where the format puts it', () => {
    // The metadata section is within the last 128 KiB; a marker further in is part of the data.
    const early = Buffer.concat([Buffer.from(fakeMmdb()), Buffer.alloc(200 * 1024)]);
    expect(looksLikeMmdb(new Uint8Array(early))).toBe(false);
    expect(looksLikeMmdb(fakeMmdb())).toBe(true);
  });
});

describe('geoipUpdateDue', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

  it('is due when the updater has never run', () => {
    expect(geoipUpdateDue(null, 24, now)).toBe(true);
  });

  it('waits out the configured interval from the last run', () => {
    expect(geoipUpdateDue(hoursAgo(23), 24, now)).toBe(false);
    expect(geoipUpdateDue(hoursAgo(24), 24, now)).toBe(true);
    expect(geoipUpdateDue(hoursAgo(2), 1, now)).toBe(true);
    expect(geoipUpdateDue(hoursAgo(100), 168, now)).toBe(false);
  });

  it('runs rather than stalls forever on an unreadable timestamp', () => {
    expect(geoipUpdateDue('not a date', 24, now)).toBe(true);
  });
});

describe('installGeoipDatabase', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cpm-geoip-install-'));
    previous = process.env.GEOIP_DIR;
    process.env.GEOIP_DIR = join(dir, 'not-yet-created');
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.GEOIP_DIR;
    else process.env.GEOIP_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the directory, replaces the file, and leaves no temporary behind', () => {
    installGeoipDatabase('GeoLite2-Country', new TextEncoder().encode('old'));
    const target = join(dir, 'not-yet-created');
    writeFileSync(join(target, 'unrelated.txt'), 'kept');

    installGeoipDatabase('GeoLite2-Country', new TextEncoder().encode('new'));

    expect(readFileSync(join(target, 'GeoLite2-Country.mmdb'), 'utf8')).toBe('new');
    expect(readdirSync(target).sort()).toEqual(['GeoLite2-Country.mmdb', 'unrelated.txt']);
  });
});
