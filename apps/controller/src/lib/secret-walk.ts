/**
 * Finds stored secrets by their marker rather than by column name, so a column added later is
 * covered without anyone updating a list. Shared by backup, the legacy importer and key rotation.
 */

/** Better Auth encrypts these with SESSION_SECRET itself (`symmetricEncrypt`), not with `enc:v1:`. */
export const BETTER_AUTH_ENCRYPTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  two_factors: ["secret", "backupCodes"],
};

/** `map` applied to every string in a parsed JSON value, keeping the structure around them. */
export function mapStrings(input: unknown, map: (text: string) => string): unknown {
  if (typeof input === "string") return map(input);
  if (Array.isArray(input)) return input.map((entry) => mapStrings(entry, map));
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [key, mapStrings(entry, map)]),
    );
  }
  return input;
}

/**
 * `map` applied to a text column holding `needle`: to the whole value, and failing a change there,
 * to every string inside it as JSON. A string that is JSON itself is walked too, since
 * settings_revisions keeps whole settings values as text. Parsed rather than rewritten by
 * substring: trailing base64 has no reliable delimiter.
 */
export function mapTextColumn(
  value: string,
  needle: string,
  map: (text: string) => string,
): string {
  if (!value.includes(needle)) return value;
  const whole = map(value);
  if (whole !== value) return whole;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  return JSON.stringify(mapStrings(parsed, (text) => mapTextColumn(text, needle, map)));
}
