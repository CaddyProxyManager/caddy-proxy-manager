import { describe, expect, it } from 'bun:test';
import * as flags from 'country-flag-icons/string/3x2';
import { isKnownCountry } from '@/src/components/ui/CountryFlag';
import { COUNTRY_CODES } from '@/src/components/proxy-hosts/protection/countries';

// A package bump that drops a flag would otherwise draw a blank square where that country was.
describe('country flags', () => {
  it('has a flag for every country the pickers offer', () => {
    const svgs = flags as unknown as Record<string, string | undefined>;
    expect(COUNTRY_CODES.filter((code) => !svgs[code]?.startsWith('<svg'))).toEqual([]);
  });

  it('treats GeoIP placeholders as no country', () => {
    for (const code of ['XX', 'EU', 'AP', 'ZZ', '', '-']) expect(isKnownCountry(code)).toBe(false);
    expect(isKnownCountry('de')).toBe(true);
  });
});
