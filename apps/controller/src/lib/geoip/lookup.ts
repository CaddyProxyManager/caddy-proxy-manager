/**
 * Approximate places for addresses the controller itself saw, such as a session's. Reads the
 * databases the updater keeps on the data volume; with none there, every answer is null.
 */
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { type AsnResponse, type CityResponse, type CountryResponse, Reader } from "maxmind";
import { geoipDatabasePath } from "../agent/geoip";

export type ApproximatePlace = {
  /** In the reader's language where the database has it, else English. */
  city: string | null;
  /** ISO 3166-1 alpha-2, named on the page through Intl. */
  countryCode: string | null;
};

export type AutonomousSystem = { number: number; organization: string | null };

type Cached = { mtimeMs: number; reader: Reader<CityResponse | CountryResponse | AsnResponse> };

const readers = new Map<string, Cached>();

/** Re-read when the updater swaps the file in; a missing or unreadable file is no reader. */
function readerFor<T extends CityResponse | CountryResponse | AsnResponse>(
  edition: "GeoLite2-City" | "GeoLite2-Country" | "GeoLite2-ASN",
): Reader<T> | null {
  const path = geoipDatabasePath(edition);
  try {
    const { mtimeMs } = statSync(path);
    const cached = readers.get(path);
    if (cached?.mtimeMs === mtimeMs) return cached.reader as Reader<T>;
    const reader = new Reader<T>(readFileSync(path));
    readers.set(path, { mtimeMs, reader: reader as Cached["reader"] });
    return reader;
  } catch {
    readers.delete(path);
    return null;
  }
}

/** The MaxMind name list's language for a locale: "pt-BR" and "zh-CN" spelled out, else the base. */
function nameKey(locale: string): string {
  if (locale === "pt-BR" || locale === "zh-CN") return locale;
  return locale.split("-")[0] ?? "en";
}

export function approximatePlace(address: string | null, locale = "en"): ApproximatePlace | null {
  if (!address) return null;
  const ip = address.replace(/^::ffff:/i, "");
  if (!isIP(ip)) return null;
  const reader =
    readerFor<CityResponse>("GeoLite2-City") ?? readerFor<CityResponse>("GeoLite2-Country");
  if (!reader) return null;
  let found: CityResponse | null = null;
  try {
    found = reader.get(ip);
  } catch {
    return null;
  }
  const countryCode = found?.country?.iso_code ?? found?.registered_country?.iso_code ?? null;
  const names = found?.city?.names as Record<string, string> | undefined;
  const city = names ? (names[nameKey(locale)] ?? names.en ?? null) : null;
  return city || countryCode ? { city, countryCode } : null;
}

/** From the ASN database on the data volume; offline mode leaves it as stale as the last refresh. */
export function autonomousSystemOf(address: string | null): AutonomousSystem | null {
  if (!address) return null;
  const ip = address.replace(/^::ffff:/i, "");
  if (!isIP(ip)) return null;
  const reader = readerFor<AsnResponse>("GeoLite2-ASN");
  if (!reader) return null;
  try {
    const found = reader.get(ip);
    if (!found?.autonomous_system_number) return null;
    return {
      number: found.autonomous_system_number,
      organization: found.autonomous_system_organization ?? null,
    };
  } catch {
    return null;
  }
}
