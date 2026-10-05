/**
 * `Intl.DisplayNames` already has CLDR names in every locale; a table would be English only. The
 * analytics map and the geoblock picker both name codes through here, so they agree.
 */

const cache = new Map<string, Intl.DisplayNames>();

/** The display name of an ISO 3166-1 alpha-2 code in `locale`, or the code when there is none. */
export function regionName(code: string, locale: string): string {
  let names = cache.get(locale);
  if (!names) {
    names = new Intl.DisplayNames([locale], { type: "region" });
    cache.set(locale, names);
  }
  try {
    return names.of(code) ?? code;
  } catch {
    // `of` throws on anything that is not shaped like a region code.
    return code;
  }
}
