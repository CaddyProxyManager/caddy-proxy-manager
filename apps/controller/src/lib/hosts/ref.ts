/** A host in a URL or REST path is its uuid; the serial id is internal and no longer accepted. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lowercased, or null for anything that is not a uuid. */
export function parseHostUuid(raw: string): string | null {
  return UUID.test(raw) ? raw.toLowerCase() : null;
}
