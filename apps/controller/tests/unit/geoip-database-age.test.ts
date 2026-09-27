/**
 * How old the MaxMind databases on disk are, from mtime (the updater replaces them wholesale). A
 * missing directory or a file vanishing mid-read must degrade to "unknown", not a failed page.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  geoipDatabaseAgeDays,
  installedGeoipDatabases,
  type GeoipDatabaseInfo,
} from '../../src/lib/agent/geoip';

const DAY_MS = 86_400_000;
let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cpm-geoip-'));
  previous = process.env.GEOIP_DIR;
  process.env.GEOIP_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.GEOIP_DIR;
  else process.env.GEOIP_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

/** Write a database file and backdate it, the way a download that many days ago would have left it. */
function writeDatabase(edition: string, ageDays: number): void {
  const path = join(dir, `${edition}.mmdb`);
  writeFileSync(path, 'not a real database, only its mtime is read');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(path, when, when);
}

describe('installedGeoipDatabases', () => {
  it('reports nothing when the directory is empty', () => {
    expect(installedGeoipDatabases()).toEqual([]);
  });

  it('reports nothing when the directory does not exist at all', () => {
    process.env.GEOIP_DIR = join(dir, 'never-created');
    expect(installedGeoipDatabases()).toEqual([]);
  });

  it('reports each installed edition with the time it was written', () => {
    writeDatabase('GeoLite2-Country', 3);
    writeDatabase('GeoLite2-ASN', 3);

    const databases = installedGeoipDatabases();

    expect(databases.map((database) => database.edition).sort()).toEqual([
      'GeoLite2-ASN',
      'GeoLite2-Country',
    ]);
    for (const database of databases) {
      expect(database.updatedAt).toBeInstanceOf(Date);
    }
  });

  it('ignores files that are not a known edition', () => {
    writeFileSync(join(dir, 'Some-Other.mmdb'), 'x');
    mkdirSync(join(dir, 'nested'));

    expect(installedGeoipDatabases()).toEqual([]);
  });
});

describe('geoipDatabaseAgeDays', () => {
  const at = (ageDays: number): GeoipDatabaseInfo => ({
    edition: 'GeoLite2-Country',
    updatedAt: new Date(Date.now() - ageDays * DAY_MS),
  });

  it('is null when nothing is installed', () => {
    expect(geoipDatabaseAgeDays([])).toBeNull();
  });

  it('counts whole days since the write', () => {
    expect(geoipDatabaseAgeDays([at(41)])).toBe(41);
  });

  it('reports 0 for a database written today', () => {
    expect(geoipDatabaseAgeDays([at(0)])).toBe(0);
  });

  it('answers for the freshest database, not the oldest', () => {
    // A deployment that added City later must not read as stale because Country is older.
    expect(
      geoipDatabaseAgeDays([at(40), { edition: 'GeoLite2-City', updatedAt: new Date() }]),
    ).toBe(0);
  });

  it('never reports a negative age for a clock-skewed future mtime', () => {
    expect(geoipDatabaseAgeDays([at(-5)])).toBe(0);
  });

  it('reads the age end to end from files on disk', () => {
    writeDatabase('GeoLite2-Country', 20);

    expect(geoipDatabaseAgeDays(installedGeoipDatabases())).toBe(20);
  });
});
