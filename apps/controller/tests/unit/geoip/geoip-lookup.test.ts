/** A session's approximate place, read from the City database the updater keeps on disk. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from '@/tests/helpers/vi';

// The real format needs a real database; what is under test is the reading around it.
vi.mock('maxmind', () => ({
  Reader: class {
    get(ip: string) {
      if (ip === '203.0.113.7') {
        return { city: { names: { en: 'Munich', de: 'München' } }, country: { iso_code: 'DE' } };
      }
      if (ip === '198.51.100.1') return { registered_country: { iso_code: 'NL' } };
      return null;
    }
  },
}));

const { approximatePlace } = await import('../../../src/lib/geoip/lookup');

let dir: string;
let empty: string;
const previous = process.env.GEOIP_DIR;

// Tests run in random order, so the directory with a database and the one without are separate.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cpm-geoip-lookup-'));
  empty = mkdtempSync(join(tmpdir(), 'cpm-geoip-empty-'));
  writeFileSync(join(dir, 'GeoLite2-City.mmdb'), 'stand-in');
  process.env.GEOIP_DIR = dir;
});

afterAll(() => {
  process.env.GEOIP_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

describe('approximatePlace', () => {
  it('answers nothing without a database', () => {
    process.env.GEOIP_DIR = empty;
    try {
      expect(approximatePlace('203.0.113.7')).toBeNull();
    } finally {
      process.env.GEOIP_DIR = dir;
    }
  });

  it('names the city in the reader language, falling back to the country alone', () => {
    expect(approximatePlace('203.0.113.7', 'de')).toEqual({ city: 'München', countryCode: 'DE' });
    expect(approximatePlace('::ffff:203.0.113.7', 'fr')).toEqual({
      city: 'Munich',
      countryCode: 'DE',
    });
    expect(approximatePlace('198.51.100.1')).toEqual({ city: null, countryCode: 'NL' });
  });

  it('ignores what is not an address, and an address nobody placed', () => {
    expect(approximatePlace(null)).toBeNull();
    expect(approximatePlace('not-an-ip')).toBeNull();
    expect(approximatePlace('192.0.2.1')).toBeNull();
  });
});
